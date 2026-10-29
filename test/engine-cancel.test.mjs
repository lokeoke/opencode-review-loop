import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../src/engine.mjs';
import { fixture } from '../test-support/engine-fixture.mjs';

test('two sessions cannot start competing runs in the same worktree', async (t) => {
  const f = await fixture(t);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  f.ctx.session.wait = async (_input, { signal } = {}) => Promise.race([blocked, new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))]);
  const first = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'], goal: 'Change value' });
  try {
    await assert.rejects(f.engine.start('fixer', { base: 'main', checks: ['exit 0'], goal: 'Change value' }), /already running/);
  } finally {
    await f.engine.stop('fixer');
    release();
  }
  await first.done;
});

test('failed interruption retains the worktree claim until cancellation is confirmed', async (t) => {
  const f = await fixture(t);
  const interrupt = f.ctx.session.interrupt;
  f.ctx.session.interrupt = async () => { throw new Error('Service interruption failed'); };
  f.setPrompt(async () => { await assert.rejects(f.engine.stop('fixer'), /interruption failed/); });
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'], goal: 'Change value' });
  await task.done;
  await assert.rejects(f.engine.start('fixer', { base: 'main', checks: ['exit 0'], goal: 'Change value' }), /already running/);
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
  f.ctx.session.wait = async (_input, { signal } = {}) => Promise.race([blocked, new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))]);
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

test('disposal during model discovery cannot register a late run', async (t) => {
  const f = await fixture(t);
  let release, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const original = f.ctx.model.list;
  f.ctx.model.list = async () => { entered(); await new Promise((resolve) => { release = resolve; }); return original(); };
  const starting = f.engine.start('fixer', { base: 'main', checks: ['exit 0'] });
  await waiting;
  await f.engine.dispose();
  release();
  await assert.rejects(starting, /unloaded/);
  assert.equal(f.engine.activeFor('fixer'), undefined);
});

test('cancellation aborts stalled reviewer creation and releases the worktree', async (t) => {
  const f = await fixture(t);
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  f.ctx.session.create = async (_input, { signal }) => {
    entered();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Creation aborted')), { once: true }));
  };
  const task = await f.engine.start('fixer', { base: 'main', checks: ['exit 0'] });
  await waiting;
  await f.engine.stop('fixer');
  await task.done;
  assert.equal((await f.engine.status('fixer')).phase, 'stopped');
  assert.equal(f.engine.activeFor('fixer'), undefined);
});
