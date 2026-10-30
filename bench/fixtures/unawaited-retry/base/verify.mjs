import { strict as assert } from 'node:assert';
import { save } from './save.mjs';
const written = new Map();
assert.equal(await save({ write: async (id, value) => written.set(id, value) }, { id: 'u1' }), true);
assert.ok(written.has('u1'));
