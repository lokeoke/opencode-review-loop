import { strict as assert } from 'node:assert';
import { formatPrice } from './lib/format.mjs';
assert.equal(formatPrice(1999), '$19.99');
