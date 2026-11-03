import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fixture } from '../test-support/engine-fixture.mjs';
import { GitScope } from '../src/git.mjs';

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
  assert.equal(state.phase, 'incomplete');
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
  assert.match(prompt, /dispute rationales.*untrusted/s);
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

test('withheld content never leaks or earns PASS, yet blocking findings in available files still get fixed', async (t) => {
  const f = await fixture(t, { autoCover: false });
  await writeFile(join(f.directory, '.env'), 'UNTRACKED_SECRET_NOT_FOR_REVIEW');
  const turns = { reviewer: 0, fixer: 0 };
  const issue = { id: 'value-regression', severity: 'major', file: 'app.js', line: 1, problem: 'Incorrect value', failure_scenario: 'Callers receive the wrong value.', suggested_fix: 'Restore the expected value.' };
  f.setPrompt(async (input) => {
    turns[input.sessionID] += 1;
    const { id: runId, round } = f.engine.activeFor('fixer').run.state;
    if (input.sessionID === 'fixer') {
      await writeFile(join(f.directory, 'app.js'), 'export const value = 3;\n');
      await f.engine.submitFix('fixer', { runId, round, summary: 'Restored the value.', disputed: [] });
      return;
    }
    assert.match(input.text, /omissions/);
    assert.ok(!input.text.includes('UNTRACKED_SECRET_NOT_FOR_REVIEW'));
    await f.engine.source('reviewer', { operation: 'read', path: 'app.js' });
    assert.match(await f.engine.source('reviewer', { operation: 'read', path: '.env' }), /^\[Unavailable:/);
    assert.match(await f.engine.source('reviewer', { operation: 'diff', path: '.env' }), /^\[Unavailable:/);
    await f.engine.submitReview('reviewer', {
      runId, round, complete: true, limitations: [], assumptions: [],
      issues: round === 1 ? [issue] : [],
      resolutions: round === 1 ? [] : [{ id: issue.id, status: 'fixed', evidence: 'app.js now returns the expected value.' }],
    });
  });
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] })).done;
  const state = await f.engine.status('fixer');
  assert.equal(state.phase, 'incomplete', state.reason);
  assert.deepEqual(turns, { reviewer: 2, fixer: 1 });
  assert.equal(state.history.length, 2);
  assert.deepEqual(state.omissions.map((entry) => entry.path), ['.env']);
  assert.match(f.reports.at(-1), /INCOMPLETE/);
  assert.match(f.reports.at(-1), /\.env/);
});

test('a changed approved snapshot stops before checks or reviewer disclosure', async (t) => {
  const f = await fixture(t);
  const snapshot = await (await GitScope.open(f.directory, 'main')).snapshot();
  await writeFile(join(f.directory, 'app.js'), 'changed after approval');
  f.setPrompt(async () => assert.fail('Changed approval must not invoke a model'));
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 7'], approvedSnapshot: { fingerprint: snapshot.fingerprint, index: snapshot.index } })).done;
  const state = await f.engine.status('fixer');
  assert.equal(state.phase, 'stopped');
  assert.match(state.reason, /changed since approval/i);
  assert.deepEqual(state.checks, []);
});

test('a scope with no inspectable content completes as incomplete without a model session', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'app.js'), 'export const value = 1;\n');
  await writeFile(join(f.directory, '.env'), 'WITHHELD');
  f.ctx.session.create = async () => assert.fail('There is no content for a reviewer');
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] })).done;
  const state = await f.engine.status('fixer');
  assert.equal(state.phase, 'incomplete');
  assert.equal(state.reviewerID, undefined);
  assert.equal(state.checks[0].results[0].exitCode, 0);
  assert.match(state.reason, /No selected files have inspectable content/);
});

test('failed approved checks remain fatal and visible even when content is omitted', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, '.env'), 'WITHHELD');
  f.setPrompt(async () => assert.fail('A failed check must not start a reviewer'));
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 7'] })).done;
  const state = await f.engine.status('fixer');
  assert.equal(state.phase, 'stopped');
  assert.equal(state.checks[0].results[0].exitCode, 7);
  assert.match(f.reports.at(-1), /Check failed with exit 7/);
  assert.match(f.reports.at(-1), /\.env/);
});

test('staging a withheld file during review never grants disclosure and stops on index change', async (t) => {
  const f = await fixture(t, { autoCover: false });
  await writeFile(join(f.directory, '.env'), 'NEVER_DISCLOSE_AFTER_STAGING');
  f.setPrompt(async () => {
    execFileSync('git', ['add', '.env'], { cwd: f.directory });
    for (const input of [{ operation: 'read', path: '.env' }, { operation: 'diff', path: '.env' }, { operation: 'search', query: 'NEVER_DISCLOSE' }]) assert.doesNotMatch(await f.engine.source('reviewer', input), /NEVER_DISCLOSE_AFTER_STAGING/);
    const active = f.engine.activeFor('fixer');
    await f.engine.submitReview('reviewer', { runId: active.run.state.id, round: 1, complete: false, limitations: [], assumptions: [], issues: [], resolutions: [] });
  });
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] })).done;
  const state = await f.engine.status('fixer');
  assert.equal(state.phase, 'stopped');
  assert.match(state.reason, /index changed during review/i);
});

test('large omission lists stay complete in status without overwhelming reviewer input or submission limits', async (t) => {
  const f = await fixture(t, { autoCover: false });
  for (let i = 0; i < 305; i++) await writeFile(join(f.directory, `.env.${i}`), 'WITHHELD');
  f.setPrompt(async (input) => {
    const data = JSON.parse(input.text.split('REVIEW INPUT (JSON data):\n')[1]);
    assert.deepEqual(data.files, ['app.js']);
    assert.equal(data.omissions.total, 305);
    assert.ok(data.omissions.paths.length <= 10);
    await f.engine.source('reviewer', { operation: 'read', path: 'app.js' });
    const active = f.engine.activeFor('fixer');
    await f.engine.submitReview('reviewer', { runId: active.run.state.id, round: 1, complete: false, limitations: [], assumptions: [], issues: [], resolutions: [] });
  });
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] })).done;
  const state = await f.engine.status('fixer');
  assert.equal(state.phase, 'incomplete');
  assert.equal(state.omissions.length, 305);
  assert.equal(state.files.length, 306);
});

test('intentional committed skill symlinks and environment examples complete a normal review', async (t) => {
  const f = await fixture(t, { autoCover: false });
  const git = (...args) => execFileSync('git', args, { cwd: f.directory, stdio: 'ignore' });
  git('checkout', '-b', 'feature');
  await mkdir(join(f.directory, '.claude', 'skills'), { recursive: true });
  await symlink('../../.agents/skills/write-post', join(f.directory, '.claude', 'skills', 'write-post'));
  await writeFile(join(f.directory, '.env.local.example'), 'EXAMPLE=placeholder\n');
  git('add', '.claude/skills/write-post', '.env.local.example');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'Intentional repository configuration');
  f.setPrompt(async (input) => {
    assert.match(input.text, /EXAMPLE=placeholder/);
    assert.match(await f.engine.source('reviewer', { operation: 'read', path: '.claude/skills/write-post' }), /Symlink target.*\.agents\/skills\/write-post/);
    await f.engine.source('reviewer', { operation: 'read', path: '.env.local.example' });
    await f.engine.source('reviewer', { operation: 'read', path: 'app.js' });
    const active = f.engine.activeFor('fixer');
    await f.engine.submitReview('reviewer', { runId: active.run.state.id, round: 1, complete: true, limitations: [], assumptions: [], issues: [], resolutions: [] });
  });
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] })).done;
  const state = await f.engine.status('fixer');
  assert.equal(state.phase, 'passed');
  assert.deepEqual(state.omissions, []);
});

test('a reviewer that skipped files without controller omissions gets exactly one retry in the same round', async (t) => {
  const f = await fixture(t);
  const prompts = [];
  f.setPrompt(async (input) => {
    prompts.push(input.text);
    const { id: runId, round } = f.engine.activeFor('fixer').run.state;
    const first = prompts.length === 1;
    await f.engine.submitReview('reviewer', { runId, round, complete: !first, limitations: first ? ['Did not trace callers of value.'] : [], assumptions: [], issues: [], resolutions: [] });
  });
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] })).done;
  const state = await f.engine.status('fixer');
  assert.equal(state.phase, 'passed', state.reason);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Did not trace callers of value\./);
  assert.equal(state.round, 1);
});

test('a second incomplete review ends the run incomplete without a third attempt', async (t) => {
  const f = await fixture(t);
  let turns = 0;
  f.setPrompt(async () => {
    turns += 1;
    const { id: runId, round } = f.engine.activeFor('fixer').run.state;
    await f.engine.submitReview('reviewer', { runId, round, complete: false, limitations: ['Did not trace callers of value.'], assumptions: [], issues: [], resolutions: [] });
  });
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] })).done;
  assert.equal((await f.engine.status('fixer')).phase, 'incomplete');
  assert.equal(turns, 2);
});

test('gaps caused by omissions are deterministic and never retried', async (t) => {
  const f = await fixture(t, { autoCover: false });
  await writeFile(join(f.directory, '.env'), 'WITHHELD');
  let turns = 0;
  f.setPrompt(async () => {
    turns += 1;
    const { id: runId, round } = f.engine.activeFor('fixer').run.state;
    await f.engine.submitReview('reviewer', { runId, round, complete: false, limitations: ['Could not read .env.'], assumptions: [], issues: [], resolutions: [] });
  });
  await (await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] })).done;
  assert.equal((await f.engine.status('fixer')).phase, 'incomplete');
  assert.equal(turns, 1);
});
