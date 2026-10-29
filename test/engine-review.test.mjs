import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_PROGRESS_EVENTS } from '../src/engine.mjs';
import { fixture } from '../test-support/engine-fixture.mjs';

test('a nonexistent-tool validation error can recover through a later valid submission', async (t) => {
  const f = await fixture(t);
  f.setPrompt(async () => {
    const active = f.engine.activeFor('fixer');
    await f.engine.submitReview('reviewer', { runId: active.run.state.id, round: 1, complete: true, issues: [], resolutions: [] });
    f.messages.set('reviewer', [{ id: 'response', type: 'assistant', finish: 'stop', content: [
      { type: 'tool', name: 'submit_placeholder', state: { status: 'error', error: { type: 'tool.execution', message: 'No tool named "submit_placeholder" is currently available. Please use a tool from the available tool list.' } } },
      { type: 'tool', name: 'review_loop_submit_review', state: { status: 'completed' } },
    ] }]);
  });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] });
  await task.done;
  assert.equal((await f.engine.status('fixer')).phase, 'passed');
});

test('a prior blocker can remain open after its file is reverted out of the diff', async (t) => {
  const f = await fixture(t);
  f.setPrompt(async (input) => {
    const active = f.engine.activeFor('fixer'), { id: runId, round } = active.run.state;
    if (input.sessionID === 'fixer') {
      await writeFile(join(f.directory, 'app.js'), 'export const value = 1;\n');
      await f.engine.submitFix('fixer', { runId, round, summary: 'Reverted file.', disputed: [] });
    } else await f.engine.submitReview('reviewer', {
      runId, round, complete: true,
      issues: [{ id: 'value', severity: 'major', file: 'app.js', line: 1, problem: 'Incorrect value.', failure_scenario: 'Callers require three.', suggested_fix: 'Return three.' }],
      resolutions: round === 1 ? [] : [{ id: 'value', status: 'open', evidence: 'Revert did not implement the fix.' }],
    });
  });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] });
  await task.done;
  assert.match((await f.engine.status('fixer')).reason, /No progress/);
});

test('regressions may be reported in unchanged source with explicit changed-code causality', async (t) => {
  const f = await fixture(t);
  f.setPrompt(async (input) => {
    const active = f.engine.activeFor('fixer'), { id: runId, round } = active.run.state;
    if (input.sessionID === 'fixer') {
      await f.engine.submitFix('fixer', { runId, round, summary: 'Needs human decision.', disputed: ['helper'] });
      return;
    }
    const issue = { id: 'helper', severity: 'major', file: 'helper.js', line: 1, problem: 'Null dereference.', failure_scenario: 'The changed caller passes undefined.', suggested_fix: 'Validate the caller input.' };
    await assert.rejects(f.engine.submitReview('reviewer', { runId, round, complete: true, issues: [issue], resolutions: [] }), /introduced_by/);
    issue.introduced_by = { file: 'app.js', line: 1, explanation: 'The modified caller introduces an undefined argument.' };
    await f.engine.submitReview('reviewer', { runId, round, complete: true, issues: [issue], resolutions: [] });
  });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] });
  await task.done;
  const state = await f.engine.status('fixer');
  assert.equal(state.issues[0].file, 'helper.js');
  assert.match(state.reason, /disputed/);
});

const guardDenial = { type: 'tool', name: 'patch', state: { status: 'error', error: { type: 'permission.rejected', message: 'Denied by review-loop policy: edit: "/x": the worktree root is a directory, not an editable file' } } };

test('a guard-denied edit that the model retries successfully does not fail the turn', async (t) => {
  const f = await fixture(t);
  f.setPrompt(async () => {
    const active = f.engine.activeFor('fixer');
    await f.engine.submitReview('reviewer', { runId: active.run.state.id, round: 1, complete: true, issues: [], resolutions: [] });
    f.messages.set('reviewer', [{ id: 'response', type: 'assistant', finish: 'stop', content: [guardDenial, { type: 'tool', name: 'patch', state: { status: 'completed' } }] }]);
  });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] });
  await task.done;
  assert.equal((await f.engine.status('fixer')).phase, 'passed');
});

test('a guard denial with no successful retry still fails the turn closed', async (t) => {
  const f = await fixture(t);
  f.setPrompt(async () => {
    const active = f.engine.activeFor('fixer');
    await f.engine.submitReview('reviewer', { runId: active.run.state.id, round: 1, complete: true, issues: [], resolutions: [] });
    f.messages.set('reviewer', [{ id: 'response', type: 'assistant', finish: 'stop', content: [guardDenial] }]);
  });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] });
  await task.done;
  assert.equal((await f.engine.status('fixer')).phase, 'stopped');
});

test('unchanged-file evidence must point at existing lines', async (t) => {
  const f = await fixture(t);
  f.setPrompt(async () => {
    const active = f.engine.activeFor('fixer'), { id: runId, round } = active.run.state;
    const issue = { id: 'helper', severity: 'major', file: 'helper.js', line: 999, problem: 'Null dereference.', failure_scenario: 'The caller passes undefined.', suggested_fix: 'Validate.', introduced_by: { file: 'app.js', line: 1, explanation: 'The changed caller passes undefined.' } };
    await assert.rejects(f.engine.submitReview('reviewer', { runId, round, complete: true, issues: [issue], resolutions: [] }), /does not exist/);
    await f.engine.submitReview('reviewer', { runId, round, complete: true, issues: [], resolutions: [] });
  });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] });
  await task.done;
  assert.equal((await f.engine.status('fixer')).phase, 'passed');
});

test('the final report is always delivered to the transcript even when an RPC channel exists', async (t) => {
  const f = await fixture(t);
  f.ctx.session.wait = async () => {};
  f.engine.report = async () => {};
  const task = await f.engine.start('fixer', { base: 'main', checks: [] });
  await task.done;
  assert.match(f.reports.at(-1), /Review loop STOPPED/);
});

test('a modified approved launch definition is never executed on the next fix pass', async (t) => {
  const f = await fixture(t);
  f.setPrompt(async (input) => {
    const active = f.engine.activeFor('fixer'), { id: runId, round } = active.run.state;
    if (input.sessionID === 'fixer') {
      await writeFile(join(f.directory, 'package.json'), JSON.stringify({ scripts: { test: 'changed launch definition' } }));
      await f.engine.submitFix('fixer', { runId, round, summary: 'Changed launch metadata.', disputed: [] });
    } else await f.engine.submitReview('reviewer', { runId, round, complete: true, issues: [{ id: 'value', severity: 'major', file: 'app.js', line: 1, problem: 'Wrong value.', failure_scenario: 'Caller receives two.', suggested_fix: 'Return three.' }], resolutions: [] });
  });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] });
  await task.done;
  const state = await f.engine.status('fixer');
  assert.match(state.reason, /check definitions changed/);
  assert.equal(state.checks[1].results.length, 0);
});

test('progress history is bounded and each delivery channel receives the terminal report once', async (t) => {
  const f = await fixture(t);
  let release;
  f.ctx.session.wait = async () => new Promise((resolve) => { release = resolve; });
  const notifications = [];
  f.engine.report = async (_id, text) => notifications.push(text);
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] });
  const active = f.engine.activeFor('fixer');
  for (let i = 0; i < MAX_PROGRESS_EVENTS + 2; i++) await f.engine.progress(active, `Event ${i}`);
  const state = await f.engine.status('fixer');
  assert.equal(state.progress.length, MAX_PROGRESS_EVENTS);
  assert.equal(state.progressDropped, 2);
  await f.engine.stop('fixer'); release(); await task.done;
  assert.equal(notifications.filter((text) => text.startsWith('Review loop STOPPED')).length, 1);
  assert.equal(f.reports.filter((text) => text.startsWith('Review loop STOPPED')).length, 1, 'transcript copy is delivered once, never skipped');
});
