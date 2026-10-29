import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommand, selectReviewer } from '../src/options.mjs';

const model = (id, providerID = 'github-copilot') => ({ id, providerID, enabled: true, status: 'active', capabilities: { tools: true } });
test('start explicitly authorizes checks and preserves quoted arguments', () => {
  assert.deepEqual(parseCommand('start --base main --goal "Fix guest access" --check "npm test" --check \'npm run lint\''), {
    action: 'start', base: 'main', goal: 'Fix guest access', checks: ['npm test', 'npm run lint'], allowSameFamily: false,
  });
  assert.throws(() => parseCommand('start --goal fix'), /check/i);
  assert.throws(() => parseCommand('start --check "npm test" --goal fix --unknown'), /unknown/i);
  assert.throws(() => parseCommand('start --check "npm test'), /quote/i);
});

test('reviewer selection changes model lineage but never changes provider', () => {
  const models = [model('gpt-6.1-sol'), model('claude-sonnet-5.5'), model('claude-sonnet-5.5', 'anthropic')];
  assert.equal(selectReviewer(models, { id: 'gpt-6.1-sol', providerID: 'github-copilot' }).id, 'claude-sonnet-5.5');
  assert.equal(selectReviewer(models, { id: 'claude-opus-5.5', providerID: 'github-copilot' }).id, 'gpt-6.1-sol');
  assert.throws(() => selectReviewer([model('gpt-6.1-sol'), model('claude-sonnet-5.5', 'anthropic')], { id: 'gpt-5.3-codex' }), /different/i);
  assert.throws(() => selectReviewer(models, { id: 'gpt-6.1-sol' }, { reviewer: 'anthropic/claude-sonnet-5.5' }), /Copilot/i);
});
