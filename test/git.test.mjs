import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, truncate, realpath, mkdir } from 'node:fs/promises';
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
  assert.deepEqual((await scope.snapshot()).omissions.map((entry) => entry.path), ['.env']);
});

test('symlink review shows target metadata without reading the destination or allowing edits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-review-loop-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root });
  git('init', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Initial');
  const target = join(root, '.git', 'secret');
  await writeFile(target, 'DESTINATION_MUST_NOT_BE_DISCLOSED');
  await symlink(target, join(root, 'external'));
  const scope = await GitScope.open(root, 'main');
  const before = await scope.snapshot();
  const outputs = [before.diff, await scope.source({ operation: 'read', path: 'external' }),
    await scope.source({ operation: 'search', query: 'Symlink target' }), (await scope.fileDiff({ path: 'external' })).text];
  for (const output of outputs) {
    assert.match(output, /Symlink target/);
    assert.ok(output.includes(target));
    assert.doesNotMatch(output, /DESTINATION_MUST_NOT_BE_DISCLOSED/);
  }
  assert.equal(await scope.canEdit('external'), false);
  await writeFile(target, 'CHANGED_DESTINATION');
  assert.equal((await scope.snapshot()).fingerprint, before.fingerprint);
  await rm(join(root, 'external'));
  await symlink('missing', join(root, 'external'));
  assert.notEqual((await scope.snapshot()).fingerprint, before.fingerprint);
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

test('binary integrity diffs retain the bounded Git-output safety limit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-review-loop-binary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-b', 'main');
  await writeFile(join(root, 'asset.bin'), Buffer.from([0, 1]));
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial');
  await writeFile(join(root, 'asset.bin'), randomBytes(7 * 1024 * 1024));
  const scope = await GitScope.open(root, 'HEAD');
  await assert.rejects(scope.snapshot(), /Git output exceeds the 8 MiB safety budget/);
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

test('tracked sensitive-looking text is reviewable through every inspection path but remains non-editable', async (t) => {
  const root = await oversizedFixture(t, 0);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('checkout', '-b', 'feature');
  await writeFile(join(root, '.env.local.example'), 'EXAMPLE=committed\n');
  git('add', '.env.local.example');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'Example configuration');
  await writeFile(join(root, '.env.local.example'), 'EXAMPLE=current\n');
  await writeFile(join(root, 'id_rsa'), 'staged fake key text\n');
  git('add', 'id_rsa');
  const scope = await GitScope.open(root, 'main');
  const snapshot = await scope.snapshot();
  assert.match(snapshot.diff, /EXAMPLE=current/);
  assert.match(snapshot.diff, /staged fake key text/);
  assert.match(await scope.source({ operation: 'read', path: '.env.local.example' }), /EXAMPLE=current/);
  assert.match(await scope.source({ operation: 'read', path: 'id_rsa' }), /staged fake key text/);
  assert.match(await scope.source({ operation: 'search', query: 'EXAMPLE=' }), /EXAMPLE=current/);
  assert.match((await scope.fileDiff({ path: '.env.local.example' })).text, /EXAMPLE=current/);
  assert.equal(await scope.canEdit('.env.local.example'), false);
  await assert.rejects(scope.source({ operation: 'read', path: '.git/config' }), /path|metadata/i);
});

test('withheld untracked secrets do not block other files or become disclosed by later staging', async (t) => {
  const root = await oversizedFixture(t, 0);
  const secret = 'WITHHELD_VALUE_MUST_NEVER_REACH_THE_REVIEWER';
  await writeFile(join(root, '.env'), secret);
  await writeFile(join(root, 'app.js'), 'reviewable code\n');
  const scope = await GitScope.open(root, 'HEAD');
  const snapshot = await scope.snapshot();
  assert.deepEqual(snapshot.files, ['.env', 'app.js']);
  assert.deepEqual(snapshot.omissions.map((entry) => entry.path), ['.env']);
  assert.match(snapshot.diff, /reviewable code/);
  assert.doesNotMatch(snapshot.diff, new RegExp(secret));
  const assertWithheld = async () => {
    const page = await scope.fileDiff({ path: '.env' });
    assert.equal(page.complete, false);
    for (const output of [page.text, await scope.source({ operation: 'read', path: '.env' }), await scope.source({ operation: 'search', query: secret })]) {
      assert.ok(!output.includes(secret));
    }
  };
  await assertWithheld();
  execFileSync('git', ['add', '.env'], { cwd: root });
  const staged = await scope.snapshot();
  assert.notEqual(staged.index, snapshot.index);
  assert.deepEqual(staged.omissions.map((entry) => entry.path), ['.env']);
  assert.ok(!staged.diff.includes(secret));
  await assertWithheld();
});

test('a formerly tracked sensitive path does not authorize an untracked replacement', async (t) => {
  const root = await oversizedFixture(t, 0);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  await writeFile(join(root, '.env'), 'OLD_COMMITTED_VALUE');
  git('add', '.env');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'Configuration');
  git('rm', '--cached', '.env');
  await writeFile(join(root, '.env'), 'PRIVATE_UNTRACKED_REPLACEMENT');
  const scope = await GitScope.open(root, 'HEAD');
  for (const stage of [false, true]) {
    if (stage) git('add', '.env');
    const snapshot = await scope.snapshot();
    assert.deepEqual(snapshot.omissions.map((entry) => entry.path), ['.env']);
    for (const output of [snapshot.diff, await scope.source({ operation: 'read', path: '.env' }), (await scope.fileDiff({ path: '.env' })).text]) assert.doesNotMatch(output, /PRIVATE_UNTRACKED_REPLACEMENT/);
  }
  await rm(join(root, '.env'));
  const deleted = await scope.snapshot();
  assert.deepEqual(deleted.omissions, []);
  assert.match(deleted.diff, /-OLD_COMMITTED_VALUE/);
  assert.equal((await scope.fileDiff({ path: '.env' })).complete, true);
});

test('binary content is omitted while text remains reviewable and binary changes remain fingerprinted', async (t) => {
  const root = await oversizedFixture(t, 0);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  await writeFile(join(root, 'asset.bin'), Buffer.from([0, 1]));
  git('add', 'asset.bin');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'Binary');
  await writeFile(join(root, 'asset.bin'), Buffer.from([0, 2]));
  await writeFile(join(root, 'new.bin'), Buffer.from([0, 3]));
  await writeFile(join(root, 'seed.txt'), 'reviewable text');
  const scope = await GitScope.open(root, 'HEAD');
  const before = await scope.snapshot();
  assert.deepEqual(before.omissions.map((entry) => entry.path), ['asset.bin', 'new.bin']);
  assert.match(before.diff, /reviewable text/);
  assert.doesNotMatch(before.diff, /GIT binary patch|\0|Binary files/);
  assert.equal((await scope.fileDiff({ path: 'asset.bin' })).complete, false);
  assert.match(await scope.source({ operation: 'read', path: 'new.bin' }), /^\[Unavailable:/);
  await writeFile(join(root, 'asset.bin'), Buffer.from([0, 4]));
  assert.notEqual((await scope.snapshot()).fingerprint, before.fingerprint);
});

test('added and deleted submodules are explicit omissions without inspecting nested files', async (t) => {
  const root = await oversizedFixture(t, 0);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  await mkdir(join(root, 'module'));
  await writeFile(join(root, 'module', 'private.txt'), 'NESTED_CONTENT_NOT_REVIEWED');
  git('update-index', '--add', '--cacheinfo', `160000,${commit},module`);
  await writeFile(join(root, 'seed.txt'), 'reviewable text');
  const added = await (await GitScope.open(root, 'HEAD')).snapshot();
  assert.deepEqual(added.omissions.map((entry) => entry.path), ['module']);
  assert.match(added.diff, /reviewable text/);
  assert.doesNotMatch(added.diff, /NESTED_CONTENT_NOT_REVIEWED/);
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'Gitlink');
  git('update-index', '--force-remove', 'module');
  await rm(join(root, 'module'), { recursive: true });
  const scope = await GitScope.open(root, 'HEAD');
  assert.deepEqual((await scope.snapshot()).omissions.map((entry) => entry.path), ['module']);
  assert.equal((await scope.fileDiff({ path: 'module' })).complete, false);
});

test('non-UTF-8 ordinary source is withheld rather than decoded into misleading replacement characters', async (t) => {
  const root = await oversizedFixture(t, 0);
  await writeFile(join(root, 'invalid.txt'), Buffer.from([255, 254]));
  const scope = await GitScope.open(root, 'HEAD');
  const snapshot = await scope.snapshot();
  assert.deepEqual(snapshot.omissions.map((entry) => entry.path), ['invalid.txt']);
  assert.match(await scope.source({ operation: 'read', path: 'invalid.txt' }), /^\[Unavailable:/);
  assert.doesNotMatch(snapshot.diff, /�/);
});

test('tracked symlink lifecycle preserves target and mode diffs, staged identity and deletion coverage', async (t) => {
  const root = await oversizedFixture(t, 0);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  await symlink('old-target', join(root, 'alias'));
  git('add', 'alias');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'Link');
  const scope = await GitScope.open(root, 'HEAD');
  await rm(join(root, 'alias')); await symlink('new-target', join(root, 'alias'));
  const before = await scope.snapshot();
  assert.match(before.diff, /120000/);
  assert.match(before.diff, /-old-target/);
  assert.match(before.diff, /\+new-target/);
  git('add', 'alias');
  const staged = await scope.snapshot();
  assert.equal(staged.fingerprint, before.fingerprint);
  assert.notEqual(staged.index, before.index);
  await rm(join(root, 'alias')); await writeFile(join(root, 'alias'), 'regular file');
  assert.match((await scope.snapshot()).diff, /new file mode 100644/);
  await rm(join(root, 'alias'));
  const deleted = await scope.snapshot();
  assert.match(deleted.diff, /deleted file mode 120000/);
  assert.match(await scope.source({ operation: 'read', path: 'alias' }), /^\[Unavailable:/);
  assert.equal((await scope.fileDiff({ path: 'alias' })).complete, true);
  assert.equal(await scope.canEdit('alias'), false, 'a deleted tracked symlink must not become an automatic edit target');
  assert.equal(await scope.canEdit('alias/child.js'), false, 'a deleted link must not become an automatic directory ancestor');
});

test('dangling, cyclic, directory and unusual-byte targets are escaped metadata, not traversed', async (t) => {
  const root = await oversizedFixture(t, 0);
  for (const [file, target] of [['dangling', 'missing'], ['directory', '.'], ['self', 'self'], ['cycle-a', 'cycle-b'], ['cycle-b', 'cycle-a'], ['escaped', 'missing\n\t\u001b'], ['raw', Buffer.from([255, 254])]]) await symlink(target, join(root, file));
  const scope = await GitScope.open(root, 'HEAD');
  assert.deepEqual((await scope.snapshot()).omissions, []);
  assert.match(await scope.source({ operation: 'read', path: 'escaped' }), /"missing\\n\\t\\u001b"/);
  assert.match(await scope.source({ operation: 'read', path: 'raw' }), /hex bytes.*fffe/);
  for (const file of ['dangling', 'directory', 'self', 'cycle-a', 'cycle-b']) {
    assert.match(await scope.source({ operation: 'read', path: file }), /Symlink target/);
    assert.equal(await scope.canEdit(file), false);
  }
});

test('tracked non-UTF-8 symlink targets retain exact bytes in diffs and integrity fingerprints', async (t) => {
  const root = await oversizedFixture(t, 0);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  await symlink('original', join(root, 'raw'));
  git('add', 'raw');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'Link');
  const scope = await GitScope.open(root, 'HEAD');
  await rm(join(root, 'raw')); await symlink(Buffer.from([255, 254]), join(root, 'raw'));
  const before = await scope.snapshot();
  await rm(join(root, 'raw')); await symlink(Buffer.from([254, 255]), join(root, 'raw'));
  const after = await scope.snapshot();
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.match(before.diff, /hex bytes.*2bfffe/);
  assert.match(after.diff, /hex bytes.*2bfeff/);
});

test('a symlink ancestor cannot disclose source or block inspection of unrelated files', async (t) => {
  const root = await oversizedFixture(t, 0);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  await mkdir(join(root, 'dir'));
  await writeFile(join(root, 'dir', 'secret.txt'), 'original');
  git('add', 'dir');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'Directory');
  await mkdir(join(root, '.git', 'destination'));
  await writeFile(join(root, '.git', 'destination', 'secret.txt'), 'ANCESTOR_DESTINATION_SECRET');
  await rm(join(root, 'dir'), { recursive: true });
  await symlink('.git/destination', join(root, 'dir'));
  await writeFile(join(root, 'seed.txt'), 'other change');
  const scope = await GitScope.open(root, 'HEAD');
  const snapshot = await scope.snapshot();
  assert.match(snapshot.diff, /other change/);
  assert.deepEqual(snapshot.omissions.map((entry) => entry.path), ['dir/secret.txt']);
  for (const output of [snapshot.diff, await scope.source({ operation: 'read', path: 'dir/secret.txt' }), await scope.source({ operation: 'search', query: 'ANCESTOR_DESTINATION_SECRET' }), (await scope.fileDiff({ path: 'dir/secret.txt' })).text]) assert.doesNotMatch(output, /ANCESTOR_DESTINATION_SECRET/);
  assert.equal(await scope.canEdit('dir/secret.txt'), false);
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

test('files beyond the inspection budget remain in scope as explicit omissions', async (t) => {
  const root = await oversizedFixture(t, 2);
  for (let i = 0; i < 300; i++) await writeFile(join(root, `f${i}.js`), `${i}\n`.repeat(1000));
  const scope = await GitScope.open(root, 'HEAD');
  const snapshot = await scope.snapshot();
  assert.equal(snapshot.files.length, 302);
  assert.equal(snapshot.omissions.length, 2);
  for (const { path, reason } of snapshot.omissions) {
    assert.match(reason, /300-file inspection budget/);
    assert.equal((await scope.fileDiff({ path })).complete, false);
    assert.match(await scope.source({ operation: 'read', path }), /^\[Unavailable:/);
  }
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

test('a cached diff is dropped by invalidate so edits made after a read are visible', async (t) => {
  const root = await oversizedFixture(t, 0);
  await writeFile(join(root, 'seed.txt'), 'first');
  const scope = await GitScope.open(root, 'HEAD');
  assert.match((await scope.fileDiff({ path: 'seed.txt' })).text, /\+first/);
  await writeFile(join(root, 'seed.txt'), 'second');
  assert.match((await scope.fileDiff({ path: 'seed.txt' })).text, /\+first/, 'served from cache until invalidated');
  scope.invalidate();
  assert.match((await scope.fileDiff({ path: 'seed.txt' })).text, /\+second/);
});

test('an oversized untracked file is fingerprinted but omitted from review content', async (t) => {
  const root = await oversizedFixture(t, 0);
  await writeFile(join(root, 'huge.js'), 'x'.repeat(512 * 1024 + 1));
  const scope = await GitScope.open(root, 'HEAD');
  const before = await scope.snapshot();
  assert.deepEqual(before.omissions.map((entry) => entry.path), ['huge.js']);
  assert.match(before.omissions[0].reason, /512 KiB/);
  assert.ok(!before.diff.includes('xxxxx'));
  await writeFile(join(root, 'huge.js'), 'y'.repeat(512 * 1024 + 1));
  assert.notEqual((await scope.snapshot()).fingerprint, before.fingerprint);
});

test('untracked files that became binary or oversized after the snapshot are not served by the diff reader', async (t) => {
  const root = await oversizedFixture(t, 0);
  await writeFile(join(root, 'late.js'), 'ok\n');
  const scope = await GitScope.open(root, 'HEAD');
  await scope.snapshot();
  await writeFile(join(root, 'late.js'), 'a\0b');
  assert.match((await scope.fileDiff({ path: 'late.js' })).text, /^\[Unavailable: Binary/);
  await writeFile(join(root, 'late.js'), 'x'.repeat(512 * 1024 + 1));
  await scope.snapshot();
  assert.match((await scope.fileDiff({ path: 'late.js' })).text, /size limit/);
});

test('past the review size limit the snapshot stays oversized without embedding new-file content', async (t) => {
  const root = await oversizedFixture(t, 0);
  for (let i = 0; i < 3; i++) await writeFile(join(root, `n${i}.js`), `${'y'.repeat(100)}\n`.repeat(1000));
  const snapshot = await (await GitScope.open(root, 'HEAD')).snapshot();
  assert.equal(snapshot.oversized, true);
  assert.equal(snapshot.diff, undefined);
});
