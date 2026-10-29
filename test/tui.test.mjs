import assert from 'node:assert/strict';
import { test } from 'node:test';
import plugin from '../src/tui.mjs';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('slash commands show immediate acknowledgement and visible results without starting model turns', async () => {
  const notices = [], dialogs = [], calls = [];
  let command, progress;
  const context = {
    client: { rpc: () => ({ command: async (input) => { calls.push(input); return { text: 'No checks approved; nothing executed.' }; }, events: { on: (_name, listener) => { progress = listener; return () => {}; } } }) },
    location: { directory: '/project' },
    keymap: { layer: (factory) => { command = factory().commands[0]; } },
    ui: { router: { current: () => ({ type: 'session', sessionID: 'fixer' }) }, toast: { show: (input) => notices.push(input.message) }, dialog: { alert: async (input) => dialogs.push(input.message) } },
  };
  const cleanup = plugin.setup(context);
  await command.run('start');
  assert.deepEqual(calls, [{ sessionID: 'fixer', text: 'start' }]);
  assert.equal(notices[0], 'Processing command…');
  assert.match(dialogs[0], /nothing executed/);
  progress({ data: { sessionID: 'fixer', text: 'Round 1/4 · Reviewing' } });
  assert.equal(notices.at(-1), 'Round 1/4 · Reviewing');
  cleanup();
});

test('Desktop bundle renders RPC results through native dialogs without a model prompt', async () => {
  const notices = [], dialogs = [];
  let command;
  const moduleExports = {};
  runInNewContext(await readFile(new URL('../dist/gui-experimental.cjs', import.meta.url), 'utf8'), {
    exports: moduleExports,
    require: (name) => name.endsWith('/rpc') ? { Rpc: { define: (value) => value } } : { Plugin: { define: (value) => value }, Command: 'command' },
  });
  moduleExports.default.setup({
    client: { rpc: () => ({ command: async () => ({ text: 'Invalid option; no work executed.' }), events: { on: () => () => {} } }) },
    sessions: { current: () => ({ id: 'fixer', directory: '/project' }) },
    toast: { show: (value) => notices.push(value.description) },
    dialogs: { alert: async (value) => dialogs.push(value.description) },
    add: (_token, value) => { command = value; },
  });
  await command.run('start --invalid');
  assert.equal(notices[0], 'Processing command…');
  assert.equal(dialogs[0], 'Invalid option; no work executed.');
});

test('proposed checks start only after explicit client approval', async () => {
  for (const approved of [false, true]) {
    const calls = [];
    let command;
    const cleanup = plugin.setup({
      location: { directory: '/project' },
      client: { rpc: () => ({ command: async (input) => { calls.push(input.text); return input.text === 'start' ? { text: 'Approve npm test?', confirmation: 'start --confirm token' } : { text: 'Started' }; }, events: { on: () => () => {} } }) },
      keymap: { layer: (factory) => { command = factory().commands[0]; } },
      ui: { router: { current: () => ({ type: 'session', sessionID: 'fixer' }) }, toast: { show: () => {} }, dialog: { confirm: async () => approved, alert: async () => {} } },
    });
    await command.run('start');
    assert.deepEqual(calls, approved ? ['start', 'start --confirm token'] : ['start']);
    cleanup();
  }
});
