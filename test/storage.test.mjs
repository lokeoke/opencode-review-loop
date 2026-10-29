import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RunStore } from '../src/storage.mjs';

test('worktree claims are exclusive, durable, and isolated across projects', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-review-loop-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const a = new RunStore(directory), b = new RunStore(directory);
  const lease = await a.acquire('/projects/a', 'run-a');
  await assert.rejects(b.acquire('/projects/a', 'run-other'), /active/i);
  const other = await b.acquire('/projects/b', 'run-b');
  await lease.save({ id: 'run-a', phase: 'reviewing' });
  assert.equal((await b.read('/projects/a')).id, 'run-a');
  assert.equal(await a.read('/projects/b'), undefined);
  await lease.release();
  const next = await b.acquire('/projects/a', 'run-next');
  await Promise.all([
    next.save({ id: 'run-next', phase: 'reviewing' }),
    next.save({ id: 'run-next', phase: 'stopped' }),
  ]);
  assert.equal((await a.read('/projects/a')).phase, 'stopped');
  assert.equal((await a.read('/projects/a', 'run-a')).phase, 'reviewing');
  const release = next.release();
  assert.throws(() => next.save({ id: 'late' }), /released|closing/i);
  await Promise.all([release, next.release()]);
  await other.release();
});

test('recovery requires explicit confirmation and never steals a live owner’s claim', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-review-loop-recover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RunStore(directory);
  const lease = await store.acquire('/projects/recover', 'run-live');
  await assert.rejects(store.recover('/projects/recover', 'run-live'), /confirmation/);
  await assert.rejects(store.recover('/projects/recover', 'run-live', { processesStopped: true }), /alive/);
  await lease.release();
});

test('explicit recovery archives a dead claim without resuming its run', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-review-loop-dead-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RunStore(directory), worktree = '/projects/dead';
  const lease = await store.acquire(worktree, 'run-dead');
  await lease.save({ id: 'run-dead', phase: 'reviewing' });
  const ownerPath = join(directory, `${store.key(worktree)}.lock/owner.json`);
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  owner.pid = spawnSync(process.execPath, ['-e', '']).pid;
  await writeFile(ownerPath, JSON.stringify(owner));
  await store.recover(worktree, 'run-dead', { processesStopped: true });
  assert.equal((await store.read(worktree)).phase, 'stopped');
  const next = await store.acquire(worktree, 'run-new');
  await next.release();
});
