import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REVIEW_SCHEMA, validateReview } from '../src/contracts.mjs';

const issue = { id: 'a', severity: 'major', file: 'app.js', line: 1, problem: 'p', failure_scenario: 's', suggested_fix: 'f' };

test('submission schema lists introduced_by as required-but-nullable for strict providers', () => {
  const schema = REVIEW_SCHEMA.properties.issues.items;
  assert.ok(schema.required.includes('introduced_by'));
  assert.ok(schema.properties.introduced_by.anyOf.some((option) => option.type === 'null'));
  assert.doesNotThrow(() => validateReview({ complete: true, issues: [{ ...issue, introduced_by: null }], resolutions: [] }));
});

test('introduced_by paths use the same worktree-relative validation as finding paths', () => {
  for (const file of ['/etc/passwd', '../x', 'a\\b', '.git/config', 'a//b']) {
    assert.throws(() => validateReview({ complete: true, issues: [{ ...issue, introduced_by: { file, line: 1, explanation: 'e' } }], resolutions: [] }), /worktree-relative/);
  }
});
