import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../test-support/engine-fixture.mjs';

test('one global command runs checks and a separate Copilot review without changing the fixer model', async (t) => {
  const f = await fixture(t);
  f.setPrompt(async (input) => {
    assert.equal(input.sessionID, 'reviewer');
    assert.match(input.text, /value = 2/);
    const active = f.engine.activeFor('fixer');
    await f.engine.submitReview('reviewer', { runId: active.run.state.id, round: 1, complete: true, issues: [], resolutions: [] });
  });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'], goal: 'Change the value to two' });
  await task.done;
  assert.equal((await f.engine.status('fixer')).phase, 'passed');
  assert.equal(f.sessions.get('fixer').model.id, 'gpt-6.1-sol');
  assert.equal(f.sessions.get('reviewer').model.providerID, 'github-copilot');
  assert.equal(f.sessions.get('reviewer').parentID, 'fixer');
  assert.match(f.reports.at(-1), /PASSED/);
});

test('starting while a loop is active tells the user to use status or stop', async (t) => {
  const f = await fixture(t);
  let release, reached;
  const prompted = new Promise((resolve) => { reached = resolve; });
  f.setPrompt(() => new Promise((resolve) => { release = resolve; reached(); }));
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] });
  await prompted;
  await assert.rejects(f.engine.start('fixer', { base: 'main', checks: ['exit 0'] }), /review-loop status.*review-loop stop/s);
  await f.engine.stop('fixer');
  release?.();
  await task.done;
});

test('a finding is fixed in the existing session and explicitly resolved by the same reviewer', async (t) => {
  const f = await fixture(t);
  f.setPrompt(async (input) => {
    const active = f.engine.activeFor('fixer');
    const { id: runId, round } = active.run.state;
    if (input.sessionID === 'fixer') {
      await writeFile(join(f.directory, 'app.js'), 'export const value = 3;\n');
      await f.engine.submitFix('fixer', { runId, round, summary: 'Corrected value.', disputed: [] });
    } else {
      await f.engine.submitReview('reviewer', {
        runId, round, complete: true,
        issues: round === 1 ? [{ id: 'value', severity: 'major', file: 'app.js', line: 1, problem: 'Incorrect value.', failure_scenario: 'Callers require three but receive two.', suggested_fix: 'Return three.' }] : [],
        resolutions: round === 1 ? [] : [{ id: 'value', status: 'fixed', evidence: 'app.js returns three.' }],
      });
    }
  });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'], goal: 'Return three' });
  await task.done;
  const state = await f.engine.status('fixer');
  assert.equal(state.phase, 'passed');
  assert.equal(state.round, 2);
  assert.equal(state.checks.length, 2);
});

test('failed or source-mutating checks never start a reviewer', async (t) => {
  for (const command of ['exit 9', 'echo mutation >> app.js']) {
    const f = await fixture(t);
    f.setPrompt(() => assert.fail('No model turn should start'));
    const task = await f.engine.start('fixer', { base: 'main', checks: [command], goal: 'Change value' });
    await task.done;
    const state = await f.engine.status('fixer');
    assert.equal(state.phase, 'stopped');
    assert.equal(state.checks[0].results[0].exitCode, command === 'exit 9' ? 9 : 0);
  }
});

test('wrong-session and duplicate submissions are rejected, and an unsuccessful turn cannot pass', async (t) => {
  const f = await fixture(t);
  f.setPrompt(async () => {
    const active = f.engine.activeFor('fixer');
    const result = { runId: active.run.state.id, round: 1, complete: true, issues: [], resolutions: [] };
    await assert.rejects(f.engine.submitReview('fixer', result), /session/);
    await f.engine.submitReview('reviewer', result);
    await assert.rejects(f.engine.submitReview('reviewer', result), /already/);
    f.sessions.get('reviewer').outcome = 'failed';
  });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'], goal: 'Change value' });
  await task.done;
  assert.equal((await f.engine.status('fixer')).phase, 'stopped');
});

test('stop interrupts the active turn and rejects late results without scheduling a fixer', async (t) => {
  const f = await fixture(t);
  let release;
  const entered = new Promise((resolve) => { release = resolve; });
  f.setPrompt(async () => {
    release();
    await f.engine.stop('fixer');
  });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'], goal: 'Change value' });
  await entered;
  await task.done;
  const state = await f.engine.status('fixer');
  assert.equal(state.phase, 'stopped');
  assert.match(state.reason, /Cancelled/);
  await assert.rejects(f.engine.submitReview('reviewer', { runId: task.id, round: 1, complete: true, issues: [], resolutions: [] }), /session/);
});
