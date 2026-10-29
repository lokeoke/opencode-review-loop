import assert from 'node:assert/strict';
import { test } from 'node:test';
import { permissionGate } from '../src/compatibility.mjs';

test('older V2 session permission API must explicitly allow custom tools', async () => {
  const gate = permissionGate({ session: { permission: { create: async () => ({ data: { effect: 'allow' } }) } } });
  await gate({ sessionID: 'reviewer', action: 'review_loop_source', resources: ['*'] });
  for (const effect of ['deny', 'ask', undefined]) {
    await assert.rejects(permissionGate({ session: { permission: { create: async () => ({ data: { effect } }) } } })({}), /permission/i);
  }
  assert.throws(() => permissionGate({}), /unsupported/i);
});
