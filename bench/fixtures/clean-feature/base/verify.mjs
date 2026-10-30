import { strict as assert } from 'node:assert';
import { slugify } from './slug.mjs';
assert.equal(slugify(' Hello, World! '), 'hello-world');
