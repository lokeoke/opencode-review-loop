import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('a global plugin exposes the review-loop command without starting work', async () => {
  const { default: plugin } = await import('../src/index.mjs');
  const commands = [];
  const cleanup = await plugin.setup({
    command: { transform: async (register) => register({ add: (command) => commands.push(command) }) },
    tool: { transform: async (register) => register({ add: () => {} }) },
    permission: { hook: async () => {} },
    session: { hook: async () => {} },
  });
  assert.equal(plugin.id, 'review-loop');
  assert.deepEqual(commands.map(({ name }) => name), ['review-loop']);
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
  let command, slash;
  const notices = [];
  const { default: plugin } = await import('../src/index.mjs');
  const cleanup = await plugin.setup({
    session: { hook: async () => {}, get: async () => ({ location: { directory: root } }), synthetic: async ({ text }) => notices.push(text) },
    permission: { hook: async () => {}, assert: async () => assert.fail('No permission request needed for preview') },
    tool: { transform: async (register) => register({ add: () => {} }) },
    command: { transform: async (register) => register({ add: (value) => { slash = value; } }) },
    rpc: { register: async (_contract, handlers) => { command = handlers.command; return { events: { emit: async () => {} } }; } },
  });
  t.after(cleanup);
  const preview = await command({ sessionID: 'fixer', text: 'start' });
  assert.match(preview.text, /app.js/);
  assert.match(preview.text, /npm test; npm run lint/);
  assert.match(preview.text, /node test.mjs/);
  assert.match(preview.confirmation, /^start --confirm /);
  await slash.execute({ sessionID: 'fallback', prompt: { text: 'start' } });
  assert.match(notices.at(-1), /\/review-loop start --confirm [a-z0-9-]+/);
  await writeFile(join(root, 'package.json'), 'malformed now');
  const expired = await command({ sessionID: 'fixer', text: preview.confirmation });
  assert.match(expired.text, /Scope changed/);
});
