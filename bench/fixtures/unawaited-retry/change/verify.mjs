import { strict as assert } from 'node:assert';
import { save, saveWithRetry } from './save.mjs';
const written = new Map();
const store = { write: async (id, value) => written.set(id, value) };
assert.equal(await save(store, { id: 'u1' }), true);
assert.equal(await saveWithRetry(store, { id: 'u2' }), true);
assert.ok(written.has('u2'));
