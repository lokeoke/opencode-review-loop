import { strict as assert } from 'node:assert';
import { slugify } from './slug.mjs';
assert.equal(slugify(' Hello, World! '), 'hello-world');
assert.equal(slugify('Hello, World', { maxLength: 6 }), 'hello');
assert.equal(slugify('Hello, World', { maxLength: 5 }), 'hello');
assert.equal(slugify('abc', { maxLength: 10 }), 'abc');
