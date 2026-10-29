import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCheck } from '../src/checks.mjs';

test('verification records actual success and rejects nonzero exits', async () => {
  assert.equal((await runCheck('exit 0', process.cwd())).exitCode, 0);
  await assert.rejects(runCheck('exit 7', process.cwd()), /exit 7/);
});

test('verification has bounded execution and supports cancellation', async () => {
  await assert.rejects(runCheck('sleep 30', process.cwd(), { timeoutMs: 30 }), /timed out/);
  const controller = new AbortController();
  const checking = runCheck('sleep 30', process.cwd(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(checking, /cancel/i);
});
