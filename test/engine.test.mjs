import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { Engine } from '../src/engine.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-review-loop-engine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
  git('init', '-b', 'main');
  await writeFile(join(directory, 'app.js'), 'export const value = 1;\n');
  git('add', 'app.js');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial');
  await writeFile(join(directory, 'app.js'), 'export const value = 2;\n');
  const sessions = new Map([['fixer', { id: 'fixer', agent: 'build', model: { providerID: 'github-copilot', id: 'gpt-6.1-sol' }, location: { directory }, outcome: 'succeeded' }]]);
  const messages = new Map();
  const reports = [];
  let onPrompt = async () => {};
  const ctx = {
    model: { list: async () => ({ location: { directory }, data: [{ id: 'claude-sonnet-5.5', providerID: 'github-copilot', enabled: true, capabilities: { tools: true } }] }) },
    session: {
      get: async ({ sessionID }) => sessions.get(sessionID),
      create: async (input) => { const session = { ...input, id: 'reviewer', location: { directory }, outcome: 'succeeded' }; sessions.set(session.id, session); return session; },
      prompt: async (input) => { await onPrompt(input); return { id: 'prompt-1' }; },
      wait: async () => {},
      context: async ({ sessionID }) => messages.get(sessionID) ?? [],
      synthetic: async ({ text, resume }) => { assert.equal(resume, false, 'Status messages must never schedule model turns'); reports.push(text); },
      interrupt: async () => ({ interrupted: true }),
    },
  };
  const engine = new Engine(ctx, { stateDirectory: join(directory, '.git/review-loop-state') });
  t.after(() => engine.dispose());
  return { directory, engine, ctx, reports, sessions, messages, setPrompt: (fn) => { onPrompt = fn; } };
}

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

test('two sessions cannot start competing runs in the same worktree', async (t) => {
  const f = await fixture(t);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  f.ctx.session.wait = async () => blocked;
  const first = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'], goal: 'Change value' });
  await assert.rejects(f.engine.start('fixer', { base: 'main', checks: ['exit 0'], goal: 'Change value' }), /active/);
  await f.engine.stop('fixer');
  release();
  await first.done;
});

test('failed interruption retains the worktree claim until cancellation is confirmed', async (t) => {
  const f = await fixture(t);
  const interrupt = f.ctx.session.interrupt;
  f.ctx.session.interrupt = async () => { throw new Error('Service interruption failed'); };
  f.setPrompt(async () => { await assert.rejects(f.engine.stop('fixer'), /interruption failed/); });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'], goal: 'Change value' });
  await task.done;
  await assert.rejects(f.engine.start('fixer', { base: 'main', checks: ['exit 0'], goal: 'Change value' }), /active/);
  f.ctx.session.interrupt = interrupt;
  await f.engine.stop('fixer');
});

test('changing the fixer model during review invalidates an otherwise clean result', async (t) => {
  const f = await fixture(t);
  f.setPrompt(async () => {
    const active = f.engine.activeFor('fixer');
    await f.engine.submitReview('reviewer', { runId: active.run.state.id, round: 1, complete: true, issues: [], resolutions: [] });
    f.sessions.get('fixer').model = { providerID: 'github-copilot', id: 'claude-sonnet-5.5' };
  });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'], goal: 'Change value' });
  await task.done;
  assert.equal((await f.engine.status('fixer')).phase, 'stopped');
});

test('location plugin instances share session ownership without unloading each other’s runs', async (t) => {
  const f = await fixture(t);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  f.ctx.session.wait = async () => blocked;
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'], goal: 'Change value' });
  const otherLocation = new Engine(f.ctx);
  try {
    assert.equal(otherLocation.activeFor('fixer')?.run.state.id, task.id);
    await otherLocation.dispose();
    assert.equal(f.engine.activeFor('fixer').run.terminal, false);
  } finally {
    await f.engine.stop('fixer');
    release();
    await task.done;
  }
});
