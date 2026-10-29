import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parsePullRequestRef, repositoryFromRemote, resolvePullRequest } from '../src/pr.mjs';

const URL = 'https://github.com/pfizer-fit/kairos-product/pull/64';

test('only strict GitHub pull-request URLs and bare numbers are references', () => {
  assert.deepEqual(parsePullRequestRef(URL), { owner: 'pfizer-fit', repo: 'kairos-product', number: 64 });
  assert.deepEqual(parsePullRequestRef('64'), { number: 64 });
  for (const bad of [`${URL}/files`, `${URL}?x=1`, `${URL}#issuecomment-1`, 'http://github.com/a/b/pull/1', 'https://evil.example/a/b/pull/1',
    'https://github.com/a/b/pull/0', 'https://github.com/a/b/pull/12345678901', 'https://github.com/a/b/issues/3', '--base', '-1', '64 65', '', 'main']) {
    assert.equal(parsePullRequestRef(bad), null, bad);
  }
});

test('remote URLs in https, ssh and scp forms identify the same repository', () => {
  for (const url of ['https://github.com/Pfizer-Fit/kairos-product.git', 'git@github.com:pfizer-fit/kairos-product.git', 'ssh://git@github.com/pfizer-fit/kairos-product', 'https://token@github.com/pfizer-fit/kairos-product/']) {
    assert.equal(repositoryFromRemote(url), 'pfizer-fit/kairos-product', url);
  }
  assert.equal(repositoryFromRemote('git@gitlab.com:a/b.git'), null);
});

async function fixture(t, remotes = { origin: 'git@github.com:pfizer-fit/kairos-product.git' }) {
  const root = await mkdtemp(join(tmpdir(), 'opencode-review-loop-pr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  for (const [name, url] of Object.entries(remotes)) git('remote', 'add', name, url);
  await writeFile(join(root, 'a.js'), '1');
  git('add', '.'); git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'a.js'), '2');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-am', 'feature');
  return { root, git, base, head: git('rev-parse', 'HEAD') };
}

const view = (f, patch = {}) => JSON.stringify({ state: 'OPEN', isDraft: true, title: 'Add signatures', body: 'Adds molecular signatures.', baseRefName: 'main', baseRefOid: f.base, headRefName: 'feat/x', headRefOid: f.head, isCrossRepository: false, changedFiles: 1, ...patch });

test('a matching checkout resolves to the merge base and passes arguments without a shell', async (t) => {
  const f = await fixture(t), calls = [];
  const info = await resolvePullRequest(parsePullRequestRef(URL), f.root, { gh: async (args) => { calls.push(args); return view(f); } });
  assert.equal(info.baseSha, f.base);
  assert.equal(info.headSha, f.head);
  assert.equal(info.number, 64);
  assert.equal(info.repository, 'pfizer-fit/kairos-product');
  assert.equal(info.title, 'Add signatures');
  assert.ok(Array.isArray(calls[0]) && calls[0].includes('--repo') && calls[0].includes('pfizer-fit/kairos-product') && calls[0].includes('64'));
});

test('a checkout that is not the pull request head is refused with the exact fix', async (t) => {
  const f = await fixture(t);
  await assert.rejects(resolvePullRequest({ number: 64 }, f.root, { gh: async () => view(f, { headRefOid: f.base }) }), /gh pr checkout 64/);
  f.git('checkout', '-q', '--detach', f.base);
  await assert.rejects(resolvePullRequest({ number: 64 }, f.root, { gh: async () => view(f) }), /gh pr checkout 64/);
});

test('merged pull requests are refused, closed ones and forks carry warnings', async (t) => {
  const f = await fixture(t);
  await assert.rejects(resolvePullRequest({ number: 64 }, f.root, { gh: async () => view(f, { state: 'MERGED' }) }), /already merged/);
  const closed = await resolvePullRequest({ number: 64 }, f.root, { gh: async () => view(f, { state: 'CLOSED', isCrossRepository: true }) });
  assert.match(closed.warnings.join('\n'), /closed/);
  assert.match(closed.warnings.join('\n'), /fork.*contributor/i);
});

test('the checkout must belong to the pull request repository; bare numbers need one unambiguous repository', async (t) => {
  const f = await fixture(t);
  await assert.rejects(resolvePullRequest({ owner: 'someone', repo: 'else', number: 1 }, f.root, { gh: async () => view(f) }), /none of this checkout's remotes/i);
  f.git('remote', 'add', 'other', 'https://github.com/someone/else.git');
  await assert.rejects(resolvePullRequest({ number: 64 }, f.root, { gh: async () => view(f) }), /more than one repository/);
  f.git('remote', 'remove', 'other'); f.git('remote', 'add', 'https', 'https://github.com/pfizer-fit/kairos-product.git');
  assert.equal((await resolvePullRequest({ number: 64 }, f.root, { gh: async () => view(f) })).repository, 'pfizer-fit/kairos-product');
});

test('GitHub CLI failures and malformed answers become actionable errors', async (t) => {
  const f = await fixture(t);
  const fail = (error) => resolvePullRequest({ number: 64 }, f.root, { gh: async () => { throw error; } });
  await assert.rejects(fail(Object.assign(new Error('x'), { code: 'ENOENT' })), /GitHub CLI.*not installed/);
  await assert.rejects(fail(Object.assign(new Error('x'), { stderr: 'To get started with GitHub CLI, please run:  gh auth login' })), /gh auth login/);
  await assert.rejects(fail(Object.assign(new Error('x'), { stderr: 'Could not resolve to a PullRequest' })), /Could not resolve/);
  await assert.rejects(resolvePullRequest({ number: 64 }, f.root, { gh: async () => 'not json' }), /unexpected answer/);
  await assert.rejects(resolvePullRequest({ number: 64 }, f.root, { gh: async () => JSON.stringify({ state: 'OPEN' }) }), /unexpected answer/);
});

test('a base commit missing locally is fetched narrowly, and a failed fetch stops with instructions', async (t) => {
  const f = await fixture(t), missing = 'a'.repeat(40), fetched = [];
  const gh = async () => view(f, { baseRefOid: missing });
  await assert.rejects(resolvePullRequest({ number: 64 }, f.root, { gh, fetchCommit: async (remote, sha) => { fetched.push([remote, sha]); } }), /still not available/);
  assert.deepEqual(fetched, [['origin', missing]]);
  await assert.rejects(resolvePullRequest({ number: 64 }, f.root, { gh, fetchCommit: async () => { throw new Error('denied'); } }), /could not fetch.*git fetch origin/is);
});

test('pull request text is bounded and carried as data', async (t) => {
  const f = await fixture(t);
  const info = await resolvePullRequest({ number: 64 }, f.root, { gh: async () => view(f, { body: 'x'.repeat(100_000) }) });
  assert.ok(info.body.length < 20_000);
  assert.match(info.body, /truncated/);
});
