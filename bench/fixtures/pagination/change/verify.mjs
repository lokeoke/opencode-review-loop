import { strict as assert } from 'node:assert';
import { paginate } from './paginate.mjs';
assert.deepEqual(paginate([1, 2, 3, 4, 5, 6], 1, 2), { items: [1, 2], totalPages: 3, hasNext: true });
assert.deepEqual(paginate([1, 2, 3, 4, 5, 6], 2, 2).items, [3, 4]);
