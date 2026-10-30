import { strict as assert } from 'node:assert';
import { applyCoupon, applyDiscount } from './discount.mjs';
assert.equal(applyDiscount(200, 25), 150);
assert.equal(applyCoupon(200, { percent: 10 }), 180);
