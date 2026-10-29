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
