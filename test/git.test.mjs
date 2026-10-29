import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, truncate, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { GitScope } from '../src/git.mjs';
import { checkPolicyFingerprint } from '../src/check-policy.mjs';

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
  assert.equal(await scope.canEdit('app.js'), true);
  assert.equal(await scope.canEdit('AGENTS.md'), false);
  assert.equal(await scope.canEdit('.opencode/plugins/escape.js'), false);
  assert.equal(await scope.canEdit('.git/config'), false);
  assert.equal(await scope.canEdit('package.json'), false);
  assert.equal(await scope.canEdit('PACKAGE.JSON'), false);
  for (const root of [scope.root, '.', '']) assert.match(await scope.editDenial(root), /root is a directory/, 'a directory resource is a specific denial, not a thrown error');
  for (const name of ['jest.config.js', 'conftest.py', 'GNUmakefile', 'go.mod']) assert.equal(await scope.canEdit(name), false, name);
  await symlink('.git/config', join(root, 'alias'));
  await symlink('/nonexistent-outside/file', join(root, 'dangling'));
  assert.equal(await scope.canEdit('alias'), false);
  assert.equal(await scope.canEdit('dangling'), false);
  await rm(join(root, 'alias')); await rm(join(root, 'dangling'));
  assert.equal(git('diff', '--cached'), staged);
  await writeFile(join(root, 'new.js'), 'export const added = false;\n');
  assert.notEqual((await scope.snapshot()).fingerprint, before.fingerprint);
  const controls = await checkPolicyFingerprint(scope);
  await writeFile(join(root, 'Makefile'), 'absent');
  assert.notEqual(await checkPolicyFingerprint(scope), controls);
  await rm(join(root, 'Makefile'));
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
  assert.doesNotMatch(await scope.source({ operation: 'search', query: 'localhost' }), /127\.0\.0\.1/);
  await rm(join(root, 'external'));
  git('checkout', '--detach');
  const detached = await GitScope.open(root, 'HEAD');
  assert.equal(detached.branch, null);
  assert.deepEqual((await detached.snapshot()).files, []);
});

test('unchanged tracked assets above 64 MiB do not consume the untracked fingerprint budget', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-review-loop-large-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-b', 'main');
  await writeFile(join(root, 'asset.bin'), '');
  await truncate(join(root, 'asset.bin'), 65 * 1024 * 1024);
  await writeFile(join(root, 'app.js'), 'before');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial');
  await writeFile(join(root, 'app.js'), 'after');
  const scope = await GitScope.open(root, 'HEAD');
  assert.deepEqual((await scope.snapshot()).files, ['app.js']);
});

test('large changed binary assets stop with a useful reason before encoded diff buffering', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-review-loop-binary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-b', 'main');
  await writeFile(join(root, 'asset.bin'), Buffer.from([0, 1]));
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial');
  await writeFile(join(root, 'asset.bin'), randomBytes(7 * 1024 * 1024));
  const scope = await GitScope.open(root, 'HEAD');
  await assert.rejects(scope.snapshot(), /Binary changes need manual review/);
});

test('resource paths are resolved against the session directory as OpenCode reports it, even through a symlinked location', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'opencode-review-loop-alias-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const real = join(base, 'real'), alias = join(base, 'alias');
  await symlink('.', join(base, 'unused')).catch(() => {});
  execFileSync('mkdir', [real]);
  const git = (...args) => execFileSync('git', args, { cwd: real, stdio: 'ignore' });
  git('init', '-b', 'main');
  await writeFile(join(real, 'app.js'), 'before');
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial');
  await symlink(real, alias);
  const scope = await GitScope.open(alias, 'HEAD');
  const canonicalFile = join(await realpath(real), 'app.js');
  // OpenCode reports the canonical file relative to the (non-canonical) session directory.
  const reported = relative(alias, canonicalFile);
  assert.match(reported, /^\.\./, 'the reported path climbs out of the alias');
  assert.equal(await scope.editDenial(reported), undefined);
  assert.equal(await scope.editDenial(canonicalFile), undefined);
  assert.match(await scope.editDenial(relative(alias, join(base, 'elsewhere.js'))), /outside the worktree/, 'a genuinely external path is still refused');
});

test('uncommitted lists tracked edits and new files but not committed work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-review-loop-extras-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-b', 'main');
  await writeFile(join(root, 'a.js'), '1');
  git('add', '.'); git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'base');
  const scope = await GitScope.open(root, 'HEAD');
  assert.deepEqual(await scope.uncommitted(), []);
  await writeFile(join(root, 'a.js'), '2');
  await writeFile(join(root, 'new.js'), 'x');
  assert.deepEqual(await scope.uncommitted(), ['a.js', 'new.js']);
});

async function oversizedFixture(t, files = 2) {
  const root = await mkdtemp(join(tmpdir(), 'opencode-review-loop-large-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-b', 'main');
  await writeFile(join(root, 'seed.txt'), 'x');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial');
  for (let i = 0; i < files; i++) await writeFile(join(root, `big${i}.js`), Array.from({ length: 6000 }, (_, n) => `export const v${n} = ${n};`).join('\n') + '\n');
  return root;
}

test('an oversized diff is not embedded; the snapshot says to read it per file', async (t) => {
  const scope = await GitScope.open(await oversizedFixture(t), 'HEAD');
  const snapshot = await scope.snapshot();
  assert.equal(snapshot.oversized, true);
  assert.equal(snapshot.diff, undefined);
  assert.deepEqual(snapshot.files, ['big0.js', 'big1.js']);
});

test('a small diff is still embedded whole', async (t) => {
  const root = await oversizedFixture(t, 0);
  await writeFile(join(root, 'seed.txt'), 'y');
  const snapshot = await (await GitScope.open(root, 'HEAD')).snapshot();
  assert.equal(snapshot.oversized, false);
  assert.match(snapshot.diff, /\+y/);
});

test('a single file diff pages to the end and reports completion; unchanged paths are refused', async (t) => {
  const root = await oversizedFixture(t);
  const scope = await GitScope.open(root, 'HEAD');
  const first = await scope.fileDiff({ path: 'big0.js', offset: 1, limit: 100 });
  assert.equal(first.complete, false);
  assert.match(first.text, /v0 = 0/);
  let page = first, offset = 101;
  while (!page.complete) { page = await scope.fileDiff({ path: 'big0.js', offset, limit: 200 }); offset += 200; }
  assert.match(page.text, /v5999 = 5999/);
  await assert.rejects(scope.fileDiff({ path: 'seed.txt', offset: 1, limit: 10 }), /not a changed file/);
  await assert.rejects(scope.fileDiff({ path: '../x', offset: 1, limit: 10 }), /not a changed file/);
});

test('a change touching more files than the review can track fails closed', async (t) => {
  const root = await oversizedFixture(t, 2);
  for (let i = 0; i < 300; i++) await writeFile(join(root, `f${i}.js`), `${i}\n`.repeat(1000));
  await assert.rejects((await GitScope.open(root, 'HEAD')).snapshot(), /more than 300 files.*split/i);
});

test('a single very long changed line is delivered in full across pages', async (t) => {
  const root = await oversizedFixture(t, 0);
  await writeFile(join(root, 'min.js'), `${'a'.repeat(10_000)}TAIL\n`);
  const scope = await GitScope.open(root, 'HEAD');
  let text = '', page, offset = 1;
  do { page = await scope.fileDiff({ path: 'min.js', offset, limit: 200 }); text += page.text; offset = page.next; } while (!page.complete);
  assert.ok(text.includes('TAIL'));
});

test('a long line is never split inside a surrogate pair', async (t) => {
  const root = await oversizedFixture(t, 0);
  await writeFile(join(root, 'emoji.js'), `${'a'.repeat(3999)}😀${'b'.repeat(10)}\n`);
  const scope = await GitScope.open(root, 'HEAD');
  let text = '', page, offset = 1;
  do { page = await scope.fileDiff({ path: 'emoji.js', offset, limit: 200 }); text += page.text; offset = page.next; } while (!page.complete);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text), 'no lone surrogate');
  assert.ok(text.includes('😀'));
});
