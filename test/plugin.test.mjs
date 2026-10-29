import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const quietContext = (extra = {}) => ({
  command: { transform: async () => assert.fail('The server must not register a slash command: each client part owns /review-loop') },
  tool: { transform: async (register) => register({ add: () => {} }) },
  permission: { hook: async () => {} },
  session: { hook: async () => {} },
  ...extra,
});

test('the server registers the RPC command but no slash command, so clients show one /review-loop each', async () => {
  const { default: plugin } = await import('../src/index.mjs');
  const registered = [];
  const cleanup = await plugin.setup(quietContext({ rpc: { register: async (contract, handlers) => { registered.push(Object.keys(handlers)); return { events: { emit: async () => {} } }; } } }));
  assert.equal(plugin.id, 'review-loop');
  assert.deepEqual(registered, [['command']]);
  await cleanup?.();
});

test('a host without client RPC gets a visible warning instead of a silently missing command', async (t) => {
  const { default: plugin } = await import('../src/index.mjs');
  const warnings = t.mock.method(console, 'warn', () => {});
  const cleanup = await plugin.setup(quietContext());
  assert.equal(warnings.mock.callCount(), 1);
  assert.match(String(warnings.mock.calls[0].arguments[0]), /no plugin RPC.*no \/review-loop command is available/is);
  await cleanup?.();
});

test('bare start previews scope and existing checks; changed scope invalidates approval without model calls', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-review-loop-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-b', 'main');
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.mjs', lint: 'eslint' } }));
  await writeFile(join(root, 'app.js'), 'before');
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial');
  await writeFile(join(root, 'app.js'), 'after');
  let command;
  const { default: plugin } = await import('../src/index.mjs');
  const cleanup = await plugin.setup({
    session: { hook: async () => {}, get: async () => ({ location: { directory: root } }) },
    permission: { hook: async () => {}, assert: async () => assert.fail('No permission request needed for preview') },
    tool: { transform: async (register) => register({ add: () => {} }) },
    command: { transform: async () => assert.fail('no server slash command') },
    rpc: { register: async (_contract, handlers) => { command = handlers.command; return { events: { emit: async () => {} } }; } },
  });
  t.after(cleanup);
  const preview = await command({ sessionID: 'fixer', text: 'start' });
  assert.match(preview.text, /app.js/);
  assert.match(preview.text, /npm test; npm run lint/);
  assert.match(preview.text, /node test.mjs/);
  assert.match(preview.confirmation, /^start --confirm /);
  await writeFile(join(root, 'package.json'), 'malformed now');
  const expired = await command({ sessionID: 'fixer', text: preview.confirmation });
  assert.match(expired.text, /Scope changed/);
});
