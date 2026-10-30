import { strict as assert } from 'node:assert';
import { paginate } from './paginate.mjs';
assert.deepEqual(paginate([1, 2, 3, 4], 2, 2), [3, 4]);
