import { strict as assert } from 'node:assert';
import { applyDiscount } from './discount.mjs';
assert.equal(applyDiscount(200, 25), 150);
assert.equal(applyDiscount(200, 150), 0);
assert.equal(applyDiscount(200, -10), 200);
