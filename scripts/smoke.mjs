import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RunStore } from '../src/storage.mjs';

if (!process.argv.includes('--live')) throw new Error('This spends Copilot usage. Run node scripts/smoke.mjs --live to authorize it.');

function api(method, path, body) {
  const args = ['api', method, path];
  if (body) args.push('--data', JSON.stringify(body));
  const raw = execFileSync('opencode', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
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
const session = api('post', '/api/session', { title: 'Review-loop live smoke', agent: 'build', model: { providerID: 'github-copilot', id: 'gpt-6.1-sol' }, location: { directory } });
console.log(`Smoke fixture: ${directory}\nFixer session: ${session.id}`);
const command = (text) => api('post', `/api/session/${session.id}/command`, { name: 'review-loop', text });
command('start --base main --goal "Implement deletion authorization: only a nonempty authenticated user ID equal to the owner ID may delete. Anonymous users must always be rejected." --check "node access.test.mjs"');
const deadline = Date.now() + 8 * 60_000;
const store = new RunStore();
const worktree = await realpath(directory);
let lastPhase;
try {
  while (Date.now() < deadline) {
    await delay(2000);
    const state = await store.read(worktree);
    if (state && ['passed', 'stopped'].includes(state.phase)) {
      console.log(`${state.phase.toUpperCase()}, ${state.round} reviews. ${state.reason ?? ''}`);
      assert.equal(state.phase, 'passed');
      assert.ok(state.round >= 2, 'The fixture must exercise a fix and a re-review.');
      const current = api('get', `/api/session/${session.id}`);
      assert.equal(current.model.id, 'gpt-6.1-sol');
      execFileSync(process.execPath, ['--input-type=module', '-e', `import { canDelete } from ${JSON.stringify(join(directory, 'access.mjs'))}; if (canDelete(null, 'owner')) process.exit(1);`]);
      console.log('Live review → fix → checks → re-review passed. Fixture and sessions retained for inspection.');
      break;
    }
    if (state) {
      const phase = `${state.phase}, round ${state.round}`;
      if (phase !== lastPhase) console.log(phase);
      lastPhase = phase;
    }
    const messages = state ? [] : api('get', `/api/session/${session.id}/context`);
    const error = messages.findLast((message) => message.type === 'synthetic' && message.text.startsWith('Review loop:'));
    if (error) throw new Error(error.text);
  }
  if (Date.now() >= deadline) throw new Error('Live smoke deadline reached.');
} catch (error) {
  command('stop');
  throw error;
}
