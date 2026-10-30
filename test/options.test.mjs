import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommand, selectReviewer } from '../src/options.mjs';

const model = (id, providerID = 'github-copilot') => ({ id, providerID, enabled: true, status: 'active', capabilities: { tools: true } });
test('start explicitly authorizes checks and preserves quoted arguments', () => {
  assert.deepEqual(parseCommand('start --base main --goal "Fix guest access" --check "npm test" --check \'npm run lint\''), {
    action: 'start', base: 'main', goal: 'Fix guest access', checks: ['npm test', 'npm run lint'], allowSameFamily: false,
  });
  assert.deepEqual(parseCommand('start'), { action: 'start', base: 'HEAD', checks: [], allowSameFamily: false });
  assert.throws(() => parseCommand('start --check "npm test" --goal fix --unknown'), /unknown/i);
  assert.throws(() => parseCommand('start --check "npm test'), /quote/i);
});

test('check arguments preserve shell backslashes rather than silently rewriting commands', () => {
  assert.deepEqual(parseCommand(String.raw`start --check "printf '%s\\n' '\d+'"`).checks, [String.raw`printf '%s\n' '\d+'`]);
});

test('reviewer selection changes model lineage but never changes provider', () => {
  const models = [model('gpt-6.1-sol'), model('claude-sonnet-5.5'), model('claude-sonnet-5.5', 'anthropic')];
  assert.equal(selectReviewer(models, { id: 'gpt-6.1-sol', providerID: 'github-copilot' }).id, 'claude-sonnet-5.5');
  assert.equal(selectReviewer(models, { id: 'claude-opus-5.5', providerID: 'github-copilot' }).id, 'gpt-6.1-sol');
  assert.throws(() => selectReviewer([model('gpt-6.1-sol'), model('claude-sonnet-5.5', 'anthropic')], { id: 'gpt-5.3-codex' }), /different/i);
  assert.throws(() => selectReviewer(models, { id: 'gpt-6.1-sol' }, { reviewer: 'anthropic/claude-sonnet-5.5' }), /Copilot/i);
});

test('a pull request URL or number is a positional reference and other positionals stay errors', () => {
  const url = 'https://github.com/pfizer-fit/kairos-product/pull/64';
  assert.deepEqual(parseCommand(`start ${url}`).pr, { owner: 'pfizer-fit', repo: 'kairos-product', number: 64 });
  assert.deepEqual(parseCommand('start 64 --check "npm test"').pr, { number: 64 });
  assert.equal(parseCommand('start --include-uncommitted').includeUncommitted, true);
  assert.throws(() => parseCommand('start main'), /Unknown argument: main.*pull request URL/);
  assert.throws(() => parseCommand(`start ${url}/files`), /Unknown argument/);
  assert.throws(() => parseCommand('start 64 --base main'), /own base/);
  assert.throws(() => parseCommand('start 64 65'), /one pull request/i);
});

test('start is the default: a bare command, flags and a pull request reference all mean start', () => {
  const url = 'https://github.com/pfizer-fit/kairos-product/pull/64';
  assert.deepEqual(parseCommand(''), parseCommand('start'));
  assert.deepEqual(parseCommand(undefined), parseCommand('start'));
  assert.deepEqual(parseCommand('64'), parseCommand('start 64'));
  assert.deepEqual(parseCommand(url), parseCommand(`start ${url}`));
  assert.deepEqual(parseCommand('--base main --check "npm test"'), parseCommand('start --base main --check "npm test"'));
  assert.equal(parseCommand('status').action, 'status');
  assert.equal(parseCommand('stop').action, 'stop');
  assert.throws(() => parseCommand('statuss'), /Unknown argument: statuss/);
});

test('a branch base keeps its full name in the scope label; only commit ids are shortened', async () => {
  const { describeScope } = await import('../src/scope.mjs');
  assert.match(describeScope({ base: 'feature/login' }), /against feature\/login$/);
  assert.match(describeScope({ base: 'main' }, 'a'.repeat(40)), /against aaaaaaa$/);
});

test('the reviewer runs at high reasoning effort when its model offers it', () => {
  const variants = (...ids) => ids.map((id) => ({ id }));
  const models = [{ ...model('claude-opus-5.5'), variants: variants('low', 'medium', 'high', 'max') }, { ...model('gpt-6.1-sol'), variants: [] }];
  assert.deepEqual(selectReviewer(models, { id: 'gpt-6.1-terra' }), { providerID: 'github-copilot', id: 'claude-opus-5.5', variant: 'high' });
  assert.deepEqual(selectReviewer(models, { id: 'claude-sonnet-5.5' }), { providerID: 'github-copilot', id: 'gpt-6.1-sol' });
  assert.equal(selectReviewer(models, { id: 'gpt-6.1-terra' }, { reviewerVariant: 'low' }).variant, 'low');
  assert.throws(() => selectReviewer(models, { id: 'gpt-6.1-terra' }, { reviewerVariant: 'turbo' }), /variant turbo.*low, medium, high, max/);
});

test('the strongest different-lineage reviewer is preferred', () => {
  const models = [model('claude-sonnet-5.5'), model('claude-opus-5.5'), model('gpt-6.1-sol')];
  assert.equal(selectReviewer(models, { id: 'gpt-6.1-terra' }).id, 'claude-opus-5.5');
});

test('reviewer variant is an explicit option', () => {
  assert.equal(parseCommand('start --reviewer-variant medium').reviewerVariant, 'medium');
  assert.throws(() => parseCommand('start --reviewer-variant'), /Missing or invalid value/);
});
