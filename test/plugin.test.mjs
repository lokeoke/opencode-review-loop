import assert from 'node:assert/strict';
import { test } from 'node:test';

test('a global plugin exposes the review-loop command without starting work', async () => {
  const { default: plugin } = await import('../src/index.mjs');
  const commands = [];
  const cleanup = await plugin.setup({
    command: { transform: async (register) => register({ add: (command) => commands.push(command) }) },
    tool: { transform: async (register) => register({ add: () => {} }) },
    permission: { hook: async () => {} },
    session: { hook: async () => {} },
  });
  assert.equal(plugin.id, 'opencode.review-loop');
  assert.deepEqual(commands.map(({ name }) => name), ['review-loop']);
  await cleanup?.();
});
