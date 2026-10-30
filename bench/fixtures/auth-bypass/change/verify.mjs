import { strict as assert } from 'node:assert';
import { canDelete } from './access.mjs';
assert.equal(canDelete('owner', 'owner'), true);
assert.equal(canDelete('other', 'owner'), false);
assert.equal(canDelete('other', 'owner', 'admin'), true);
