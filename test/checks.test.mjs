import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPath, resolveShellPath, runCheck } from '../src/checks.mjs';

test('verification records actual success and rejects nonzero exits', async () => {
  assert.equal((await runCheck('exit 0', process.cwd())).exitCode, 0);
  await assert.rejects(runCheck('exit 7', process.cwd()), (error) => error.exitCode === 7 && /exit 7/.test(error.message));
});

test('verification has bounded execution and supports cancellation', async () => {
  await assert.rejects(runCheck('sleep 30', process.cwd(), { timeoutMs: 30 }), /timed out/);
  const controller = new AbortController();
  const checking = runCheck('sleep 30', process.cwd(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(checking, /cancel/i);
});

test('signalling failures reject the check instead of escaping an exit callback', async (t) => {
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('Signalling refused'), { code: 'EPERM' }); });
  await assert.rejects(runCheck('exit 0', process.cwd()), (error) => error.cleanupUnconfirmed === true);
});

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'review-loop-checks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function script(directory, name, body) {
  const path = join(directory, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

test('checks run with the PATH they are given, so tools outside the service PATH are found', async (t) => {
  const directory = await scratch(t);
  await script(directory, 'project-tool', 'exit 0');
  await assert.rejects(runCheck('project-tool', process.cwd(), { path: '/usr/bin:/bin' }), (error) => error.exitCode === 127 && /command not found.*PATH=\/usr\/bin:\/bin/.test(error.message));
  assert.equal((await runCheck('project-tool', process.cwd(), { path: `${directory}:/usr/bin:/bin` })).exitCode, 0);
});

test('the login shell PATH comes first and keeps the service PATH entries after it', async (t) => {
  const directory = await scratch(t);
  // Noise before the marker, including a PATH= line, is profile output, not the environment.
  const shell = await script(directory, 'shell', `echo 'PATH=/from/profile/noise'; echo __REVIEW_LOOP_PATH__; echo 'HOME=/home/user'; echo 'PATH=/opt/tools/bin:/usr/bin'`);
  assert.equal(await resolveShellPath({ shell, fallback: '/usr/bin:/bin' }), '/opt/tools/bin:/usr/bin:/bin');
});

test('an unusable login shell falls back to the service PATH', async (t) => {
  const directory = await scratch(t);
  assert.equal(await resolveShellPath({ shell: join(directory, 'missing'), fallback: '/usr/bin:/bin' }), '/usr/bin:/bin');
  const silent = await script(directory, 'silent', 'exit 0');
  assert.equal(await resolveShellPath({ shell: silent, fallback: '/usr/bin:/bin' }), '/usr/bin:/bin');
  const hanging = await script(directory, 'hanging', 'sleep 30');
  assert.equal(await resolveShellPath({ shell: hanging, fallback: '/usr/bin:/bin', timeoutMs: 200 }), '/usr/bin:/bin');
});

test('a failed shell lookup is retried by the next check instead of being kept for the service lifetime', async (t) => {
  const directory = await scratch(t);
  const original = process.env.SHELL;
  t.after(() => { process.env.SHELL = original; });
  process.env.SHELL = join(directory, 'missing');
  assert.equal(await checkPath(), process.env.PATH);
  process.env.SHELL = await script(directory, 'shell', `echo __REVIEW_LOOP_PATH__; echo 'PATH=/opt/tools/bin'`);
  assert.match(await checkPath(), /^\/opt\/tools\/bin:/);
});
