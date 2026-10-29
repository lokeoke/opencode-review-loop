import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installGuards } from '../src/security.mjs';

test('reviewer model requests see only source and result tools, not shell, MCP, or delegation', async () => {
  const hooks = {};
  const active = { reviewerID: 'reviewer', fixerID: 'fixer', run: { terminal: false, state: { phase: 'reviewing' } } };
  const ctx = {
    session: { hook: async (name, fn) => { hooks[name] = fn; } },
    permission: { hook: async (name, fn) => { hooks[name] = fn; } },
  };
  await installGuards(ctx, { activeFor: (id) => id === 'reviewer' ? active : undefined });
  const event = { sessionID: 'reviewer', tools: { shell: {}, mcp_write: {}, subagent: {}, review_loop_source: {}, review_loop_submit_review: {} } };
  await hooks.context(event);
  assert.deepEqual(Object.keys(event.tools), ['review_loop_source', 'review_loop_submit_review']);
  const request = { sessionID: 'reviewer', action: 'shell', resources: ['echo hi'], effect: 'allow' };
  await hooks.evaluate(request);
  assert.equal(request.effect, 'deny');
});

test('fixer edits must stay inside the worktree and no tools remain after submission', async () => {
  const hooks = {};
  const active = { reviewerID: 'reviewer', fixerID: 'fixer', run: { terminal: false, state: { phase: 'fixing' } }, scope: { canEdit: async (path) => path === 'app.js' } };
  await installGuards({
    session: { hook: async (name, fn) => { hooks[name] = fn; } },
    permission: { hook: async (name, fn) => { hooks[name] = fn; } },
  }, { activeFor: () => active, assertSession: async () => {} });
  const outside = { sessionID: 'fixer', action: 'edit', resources: ['../outside'], effect: 'allow' };
  await hooks.evaluate(outside);
  assert.equal(outside.effect, 'deny');
  const inside = { sessionID: 'fixer', action: 'edit', resources: ['app.js'], effect: 'allow' };
  await hooks.evaluate(inside);
  assert.equal(inside.effect, 'allow');
  active.run.state.fix = { summary: 'Done' };
  const event = { sessionID: 'fixer', tools: { patch: {}, review_loop_source: {}, review_loop_submit_fix: {} } };
  await hooks.context(event);
  assert.deepEqual(event.tools, {});
});

test('unrelated user input cancels rather than silently steering an automatic run', async () => {
  const hooks = {}, stops = [];
  const active = { turnSessionID: 'fixer', run: { state: { id: 'run-1', round: 1 } } };
  await installGuards({
    session: { hook: async (name, fn) => { hooks[name] = fn; } },
    permission: { hook: async (name, fn) => { hooks[name] = fn; } },
  }, { activeFor: () => active, stop: async (id) => stops.push(id) });
  await hooks.prompt({ sessionID: 'fixer', metadata: { reviewLoop: { id: 'run-1', round: 1 } } });
  assert.deepEqual(stops, []);
  await hooks.prompt({ sessionID: 'fixer', prompt: { text: 'Change the task' } });
  assert.deepEqual(stops, ['fixer']);
});
