import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../test-support/engine-fixture.mjs';

test('the reviewer session uses the selected reasoning variant and reports it', async (t) => {
  const f = await fixture(t);
  f.ctx.model.list = async () => ({ data: [{ id: 'claude-sonnet-5.5', providerID: 'github-copilot', enabled: true, capabilities: { tools: true }, variants: [{ id: 'medium' }, { id: 'high' }] }] });
  f.setPrompt(async () => {
    const active = f.engine.activeFor('fixer');
    await f.engine.submitReview('reviewer', { runId: active.run.state.id, round: 1, complete: true, limitations: [], assumptions: [], issues: [], resolutions: [] });
    f.messages.set('reviewer', [{ id: 'response', type: 'assistant', finish: 'stop', content: [{ type: 'tool', name: 'review_loop_submit_review', state: { status: 'completed' } }] }]);
  });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] });
  await task.done;
  assert.deepEqual(f.sessions.get('reviewer').model, { providerID: 'github-copilot', id: 'claude-sonnet-5.5', variant: 'high' });
  assert.equal((await f.engine.status('fixer')).phase, 'passed');
  assert.match(f.reports.at(-1), /Reviewer: github-copilot\/claude-sonnet-5\.5 \(high\)/);
});

test('an embedded diff still needs every changed file opened before a complete review', async (t) => {
  const f = await fixture(t, { autoCover: false });
  let refusal;
  f.setPrompt(async () => {
    const { id: runId } = f.engine.activeFor('fixer').run.state;
    const review = { runId, round: 1, complete: true, limitations: [], assumptions: [], issues: [], resolutions: [] };
    await assert.rejects(f.engine.submitReview('reviewer', review), (error) => { refusal = error.message; return true; });
    await f.engine.source('reviewer', { operation: 'read', path: 'app.js' });
    await f.engine.submitReview('reviewer', review);
    f.messages.set('reviewer', [{ id: 'response', type: 'assistant', finish: 'stop', content: [{ type: 'tool', name: 'review_loop_submit_review', state: { status: 'completed' } }] }]);
  });
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] })).done;
  assert.match(refusal, /not inspected.*app\.js.*"read"/s);
  assert.equal((await f.engine.status('fixer')).phase, 'passed');
});

test('a review that names coverage limitations cannot claim to be complete', async (t) => {
  const f = await fixture(t);
  f.setPrompt(async () => {
    const { id: runId } = f.engine.activeFor('fixer').run.state;
    const review = { runId, round: 1, issues: [], resolutions: [], limitations: ['Did not trace callers of value.'], assumptions: [] };
    await assert.rejects(f.engine.submitReview('reviewer', { ...review, complete: true }), /limitations.*complete=false/);
    await f.engine.submitReview('reviewer', { ...review, complete: false });
    f.messages.set('reviewer', [{ id: 'response', type: 'assistant', finish: 'stop', content: [{ type: 'tool', name: 'review_loop_submit_review', state: { status: 'completed' } }] }]);
  });
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] })).done;
  const state = await f.engine.status('fixer');
  assert.equal(state.phase, 'stopped');
  assert.match(state.reason, /Incomplete review: Did not trace callers of value\./);
});

test('the reviewer is told to investigate first, report limitations and submit as its final action', async (t) => {
  const f = await fixture(t);
  let prompt;
  f.setPrompt(async (input) => {
    prompt = input.text;
    const { id: runId } = f.engine.activeFor('fixer').run.state;
    await f.engine.submitReview('reviewer', { runId, round: 1, complete: true, limitations: [], assumptions: [], issues: [], resolutions: [] });
    f.messages.set('reviewer', [{ id: 'response', type: 'assistant', finish: 'stop', content: [{ type: 'tool', name: 'review_loop_submit_review', state: { status: 'completed' } }] }]);
  });
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] })).done;
  assert.match(prompt, /operation "read"/);
  assert.match(prompt, /limitations/);
  assert.match(prompt, /assumptions/);
  assert.match(prompt, /final action/);
  assert.doesNotMatch(prompt, /finish immediately/);
});

test('the reviewer closing text and session are shown in status and the final report', async (t) => {
  const f = await fixture(t);
  f.setPrompt(async () => {
    const { id: runId } = f.engine.activeFor('fixer').run.state;
    await f.engine.submitReview('reviewer', { runId, round: 1, complete: true, limitations: [], assumptions: [], issues: [], resolutions: [] });
    f.messages.set('reviewer', [{ id: 'response', type: 'assistant', finish: 'stop', content: [
      { type: 'tool', name: 'review_loop_submit_review', state: { status: 'completed' } },
      { type: 'text', text: `My coverage was thinner than complete suggests. ${'x'.repeat(5000)}` },
    ] }]);
  });
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] })).done;
  const state = await f.engine.status('fixer');
  assert.match(state.reviewerNote, /^My coverage was thinner/);
  assert.ok(state.reviewerNote.length <= 2000);
  assert.match(f.reports.at(-1), /Reviewer session: reviewer/);
  assert.match(f.reports.at(-1), /Reviewer note \(model text, unverified\): My coverage was thinner/);
});

test('assumptions about the outside world are reported but do not make a review incomplete', async (t) => {
  const f = await fixture(t);
  f.setPrompt(async () => {
    const { id: runId } = f.engine.activeFor('fixer').run.state;
    await f.engine.submitReview('reviewer', { runId, round: 1, complete: true, limitations: [], assumptions: ['Callers outside this repository pass a trusted role.'], issues: [], resolutions: [] });
    f.messages.set('reviewer', [{ id: 'response', type: 'assistant', finish: 'stop', content: [{ type: 'tool', name: 'review_loop_submit_review', state: { status: 'completed' } }] }]);
  });
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] })).done;
  assert.equal((await f.engine.status('fixer')).phase, 'passed');
  assert.match(f.reports.at(-1), /Reviewer assumptions \(unverified\): Callers outside this repository pass a trusted role\./);
});

test('a refused incomplete-coverage submission can be corrected within the same turn', async (t) => {
  const f = await fixture(t, { autoCover: false });
  f.setPrompt(async () => {
    const { id: runId } = f.engine.activeFor('fixer').run.state;
    const review = { runId, round: 1, complete: true, limitations: [], assumptions: [], issues: [], resolutions: [] };
    await assert.rejects(f.engine.submitReview('reviewer', review, { toolCallID: 'refused' }), /not inspected/);
    await f.engine.source('reviewer', { operation: 'read', path: 'app.js' });
    await f.engine.submitReview('reviewer', review, { toolCallID: 'corrected' });
    f.messages.set('reviewer', [{ id: 'response', type: 'assistant', finish: 'stop', content: [
      { type: 'tool', id: 'refused', name: 'review_loop_submit_review', state: { status: 'error', error: { type: 'unknown', message: 'Complete review refused.' } } },
      { type: 'tool', id: 'corrected', name: 'review_loop_submit_review', state: { status: 'completed' } },
    ] }]);
  });
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] })).done;
  assert.equal((await f.engine.status('fixer')).phase, 'passed');
});
