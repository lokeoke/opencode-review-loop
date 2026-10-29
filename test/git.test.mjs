import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { GitScope } from '../src/git.mjs';

test('a pinned scope includes staged, unstaged, and new files without modifying the index', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-review-loop-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  await writeFile(join(root, 'app.js'), 'export const value = 1;\n');
  git('add', 'app.js'); git('commit', '-m', 'Initial');
  await writeFile(join(root, 'app.js'), 'export const value = 2;\n');
  git('add', 'app.js');
  await writeFile(join(root, 'app.js'), 'export const value = 3;\n');
  await writeFile(join(root, 'new.js'), 'export const added = true;\n');
  const staged = git('diff', '--cached');
  const scope = await GitScope.open(root, 'main');
  const before = await scope.snapshot();
  assert.deepEqual(before.files, ['app.js', 'new.js']);
  assert.match(before.diff, /value = 3/);
  assert.match(before.diff, /added = true/);
  assert.match(await scope.source({ operation: 'read', path: 'app.js' }), /value = 3/);
  assert.match(await scope.source({ operation: 'search', query: 'added' }), /new.js:1/);
  await assert.rejects(scope.source({ operation: 'read', path: '../outside' }), /path|source/i);
  await assert.rejects(scope.source({ operation: 'read', path: '.git/config' }), /path|source/i);
  assert.equal(git('diff', '--cached'), staged);
  await writeFile(join(root, 'new.js'), 'export const added = false;\n');
  assert.notEqual((await scope.snapshot()).fingerprint, before.fingerprint);
  await writeFile(join(root, '.env'), 'SECRET=not-a-real-secret');
  await assert.rejects(scope.snapshot(), /sensitive/i);
});

test('changed symlinks are rejected rather than reading outside the worktree', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-review-loop-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root });
  git('init', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Initial');
  await symlink('/etc/hosts', join(root, 'external'));
  const scope = await GitScope.open(root, 'main');
  await assert.rejects(scope.snapshot(), /symlink/i);
});
