import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RunStore } from '../src/storage.mjs';
import { INPUT_WARNING } from '../src/command.mjs';

if (!process.argv.includes('--live')) throw new Error('This spends Copilot usage. Run node scripts/smoke.mjs --live to authorize it.');

const registrationPath = process.env.OPENCODE_TEST_SERVICE_FILE || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'opencode/service.json');
const endpoint = JSON.parse(await readFile(registrationPath, 'utf8'));
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint.url).hostname) || !endpoint.password) throw new Error('Smoke needs an authenticated local existing service.');
async function api(method, path, body) {
  const current = JSON.parse(await readFile(registrationPath, 'utf8'));
  if (current.id !== endpoint.id || current.pid !== endpoint.pid) throw new Error('Service identity changed; refusing automatic continuation.');
  const response = await fetch(new URL(path, endpoint.url), {
    method: method.toUpperCase(),
    headers: { authorization: `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString('base64')}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OpenCode ${method} ${path} failed with HTTP ${response.status}.`);
  const raw = await response.text();
  if (!raw.trim()) return undefined;
  const result = JSON.parse(raw);
  return result.data ?? result;
}

const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP || tmpdir(), 'opencode-review-loop-smoke-'));
const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
git('init', '-b', 'main');
await writeFile(join(directory, 'access.mjs'), 'export function canDelete(userId, ownerId) { return false; }\n');
await writeFile(join(directory, 'access.test.mjs'), `import { strict as assert } from 'node:assert';
import { canDelete } from './access.mjs';
assert.equal(canDelete('owner', 'owner'), true);
assert.equal(canDelete('other', 'owner'), false);
`);
git('add', '.');
git('-c', 'user.name=Smoke test', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'Initial fixture');
await writeFile(join(directory, 'access.mjs'), 'export function canDelete(userId, ownerId) { return !userId || userId === ownerId; }\n');
const session = await api('post', '/api/session', { title: 'Review-loop live smoke', agent: 'build', model: { providerID: 'github-copilot', id: 'gpt-6.1-sol' }, location: { directory } });
console.log(`Smoke fixture: ${directory}\nFixer session: ${session.id}`);
const command = async (text) => (await api('post', '/api/rpc/review-loop/command', { input: { sessionID: session.id, text } })).output;
const deadline = Date.now() + 8 * 60_000;
const store = new RunStore();
const worktree = await realpath(directory);
let lastPhase;
let terminal = false;
let started = false;
try {
  const preview = await command('start');
  if (!preview.text.includes(INPUT_WARNING)) throw new Error('Candidate warning not loaded in the service; refusing to run the smoke.');
  const response = await command('start --check "node access.test.mjs"');
  if (response.text.startsWith('Review loop:')) throw new Error(response.text);
  started = true;
  while (Date.now() < deadline) {
    await delay(2000);
    const state = await store.read(worktree);
    if (state && ['passed', 'stopped'].includes(state.phase)) {
      terminal = true;
      console.log(`${state.phase.toUpperCase()}, ${state.round} reviews. ${state.reason ?? ''}`);
      assert.equal(state.phase, 'passed');
      assert.ok(state.round >= 2, 'The fixture must exercise a fix and a re-review.');
      const current = await api('get', `/api/session/${session.id}`);
      assert.equal(current.model.id, 'gpt-6.1-sol');
      execFileSync(process.execPath, ['--input-type=module', '-e', `import { canDelete } from ${JSON.stringify(join(directory, 'access.mjs'))}; if (canDelete(null, 'owner')) process.exit(1);`]);
      if (!state.reviewerID) throw new Error('INCONCLUSIVE: no reviewer session was recorded.');
      const messages = await api('get', `/api/session/${state.reviewerID}/context`);
      const completed = new Set(messages.flatMap((message) => message.content ?? []).filter((part) => part.type === 'tool' && part.state?.status === 'completed').map((part) => part.name));
      const missing = ['review_loop_source', 'review_loop_submit_review'].filter((name) => !completed.has(name));
      if (missing.length) throw new Error(`INCONCLUSIVE: no successful ${missing.join(', ')} call was recorded; model behavior may vary.`);
      console.log('Reviewer source access and review submission verified in the session transcript.');
      console.log('Live review → fix → checks → re-review passed. Fixture and sessions retained for inspection.');
      break;
    }
    if (state) {
      const phase = `${state.phase}, round ${state.round}`;
      if (phase !== lastPhase) console.log(phase);
      lastPhase = phase;
    }
    const messages = state ? [] : await api('get', `/api/session/${session.id}/context`);
    const error = messages.findLast((message) => message.type === 'synthetic' && message.text.startsWith('Review loop:'));
    if (error) throw new Error(error.text);
  }
  if (!terminal) throw new Error('Live smoke deadline reached.');
} catch (error) {
  if (started && !terminal) try { await command('stop'); } catch { console.error('Unable to confirm smoke cancellation; inspect retained run state.'); }
  throw error;
}
