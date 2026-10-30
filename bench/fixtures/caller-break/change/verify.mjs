import { strict as assert } from 'node:assert';
import { formatPrice } from './lib/format.mjs';
assert.equal(formatPrice({ cents: 1999 }), '$19.99');
assert.equal(formatPrice({ cents: 500, currency: 'EUR' }), '€5.00');
