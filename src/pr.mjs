import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,8})$/;
const PR_NUMBER = /^[1-9][0-9]{0,8}$/;
const REMOTE_URL = /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/:]+@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const SHA = /^[0-9a-f]{40}$/;
const GH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_GH_OUTPUT = 4 * 1024 * 1024;
export const MAX_PR_TITLE = 300;
export const MAX_PR_BODY = 8_000;
const FIELDS = 'state,isDraft,title,body,baseRefName,baseRefOid,headRefName,headRefOid,isCrossRepository,changedFiles';

export function parsePullRequestRef(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  const url = PR_URL.exec(value);
  if (url) return { owner: url[1], repo: url[2], number: Number(url[3]) };
  return PR_NUMBER.test(value) ? { number: Number(value) } : null;
}

export function repositoryFromRemote(url) {
  const match = REMOTE_URL.exec(String(url).trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

async function git(directory, args, timeout = GIT_TIMEOUT_MS) {
  const { stdout } = await exec('git', args, { cwd: directory, encoding: 'utf8', timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout.trim();
}

async function runGh(args) {
  const { stdout } = await exec('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: MAX_GH_OUTPUT, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
  return stdout;
}

async function fetchFromRemote(remote, sha, directory) {
  await git(directory, ['fetch', '--no-tags', '--quiet', remote, sha], FETCH_TIMEOUT_MS);
}

function explainGhFailure(error) {
  if (error.code === 'ENOENT') return 'The GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com and run: gh auth login';
  const detail = String(error.stderr || error.message || '').trim().split('\n')[0];
  if (/gh auth login|not logged in|authentication|SAML|SSO/i.test(detail)) return `The GitHub CLI is not signed in, or this organisation requires SSO authorisation. Run: gh auth login (${detail})`;
  return `The GitHub CLI could not read the pull request: ${detail || 'unknown error'}`;
}

async function githubRemotes(directory) {
  let output = '';
  try { output = await git(directory, ['config', '--get-regexp', '^remote\\..*\\.url$']); } catch { /* no remotes */ }
  return output.split('\n').filter(Boolean).flatMap((line) => {
    const [key, ...rest] = line.split(' ');
    const repository = repositoryFromRemote(rest.join(' '));
    return repository ? [{ name: key.slice('remote.'.length, -'.url'.length), repository }] : [];
  });
}

const hasCommit = async (directory, sha) => git(directory, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);

function validate(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { data = undefined; }
  const ok = data && typeof data.state === 'string' && typeof data.title === 'string' && typeof data.baseRefName === 'string'
    && typeof data.headRefName === 'string' && SHA.test(data.baseRefOid ?? '') && SHA.test(data.headRefOid ?? '');
  if (!ok) throw new Error('GitHub returned an unexpected answer for this pull request; no review was started.');
  return data;
}

const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}\n[truncated: ${text.length - limit} more characters]` : text);

/**
 * Resolve a pull request to a local review scope. It never changes the checkout: the working tree must already be at the
 * pull request's head, otherwise the exact `gh pr checkout` command is returned as the fix.
 */
export async function resolvePullRequest(ref, directory, { gh = runGh, fetchCommit = fetchFromRemote } = {}) {
  const remotes = await githubRemotes(directory);
  const known = new Set(remotes.map((remote) => remote.repository));
  let repository;
  if (ref.owner) {
    repository = `${ref.owner}/${ref.repo}`.toLowerCase();
    if (!known.has(repository)) throw new Error(`None of this checkout's remotes point at ${repository}. Open the project that contains that repository, or check it out first.`);
  } else {
    if (known.size === 0) throw new Error('This checkout has no GitHub remote, so a bare pull-request number cannot be resolved. Pass the full pull request URL.');
    if (known.size > 1) throw new Error('This checkout has remotes for more than one repository. Pass the full pull request URL.');
    [repository] = known;
  }

  let raw;
  try { raw = await gh(['pr', 'view', String(ref.number), '--repo', repository, '--json', FIELDS]); }
  catch (error) { throw new Error(explainGhFailure(error)); }
  const data = validate(raw);
  if (data.state === 'MERGED') throw new Error(`Pull request #${ref.number} is already merged. Review the merge commit with --base instead.`);

  const warnings = [];
  if (data.state === 'CLOSED') warnings.push(`Pull request #${ref.number} is closed.`);
  if (data.isCrossRepository) warnings.push("This is a fork pull request: approving checks runs the contributor's code with your permissions.");

  const head = await git(directory, ['rev-parse', 'HEAD']);
  if (head !== data.headRefOid) {
    const ahead = await git(directory, ['merge-base', '--is-ancestor', data.headRefOid, 'HEAD']).then(() => true, () => false);
    throw new Error(`${ahead ? 'This checkout has local commits beyond' : 'This checkout is not at'} the head of pull request #${ref.number} (${data.headRefName} at ${data.headRefOid.slice(0, 7)}). Check it out with: gh pr checkout ${ref.number}`);
  }

  if (!await hasCommit(directory, data.baseRefOid)) {
    const remote = remotes.find((candidate) => candidate.repository === repository).name;
    try { await fetchCommit(remote, data.baseRefOid, directory); }
    catch (error) { throw new Error(`Could not fetch the pull request base commit from ${remote} (${error.message}). Run: git fetch ${remote} ${data.baseRefOid} and retry.`); }
    if (!await hasCommit(directory, data.baseRefOid)) throw new Error(`The pull request base commit ${data.baseRefOid.slice(0, 7)} is still not available locally. Run: git fetch ${remote} and retry.`);
  }
  let baseSha;
  try { baseSha = await git(directory, ['merge-base', 'HEAD', data.baseRefOid]); }
  catch { throw new Error('Could not compute the merge base with the pull request base; the clone may be shallow. Run: git fetch --unshallow and retry.'); }

  return {
    number: ref.number, repository, state: data.state, isDraft: Boolean(data.isDraft), isCrossRepository: Boolean(data.isCrossRepository),
    title: clip(data.title, MAX_PR_TITLE), body: clip(data.body ?? '', MAX_PR_BODY), headRef: data.headRefName, headSha: data.headRefOid,
    baseRef: data.baseRefName, baseTipSha: data.baseRefOid, baseSha, changedFiles: data.changedFiles, warnings,
  };
}
