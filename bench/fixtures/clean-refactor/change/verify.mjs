import { strict as assert } from 'node:assert';
import { displayName, initials } from './names.mjs';
assert.equal(displayName({ first: ' Ada ', last: 'Lovelace ' }), 'Ada Lovelace');
assert.equal(displayName({ first: 'Ada', last: 'Lovelace', nickname: ' Countess ' }), 'Countess');
assert.equal(displayName({ first: 'Ada', last: 'Lovelace', nickname: '  ' }), 'Ada Lovelace');
assert.equal(initials({ first: 'ada', last: 'lovelace' }), 'AL');
