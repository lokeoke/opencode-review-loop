import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
  await next.release();
  await other.release();
});
