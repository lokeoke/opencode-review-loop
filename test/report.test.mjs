import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFindings, formatStatus } from '../src/report.mjs';

const issue = { id: 'R1', severity: 'major', file: 'lib/data.ts', line: 182, problem: 'Unbounded loop over the year range.', failure_scenario: 'yearMax=2147483647 blocks the event loop.', suggested_fix: 'Bound the span.', introduced_by: null };

test('findings render as readable lines, never as JSON', () => {
  const text = formatFindings([issue]);
  assert.match(text, /\[major\] R1 lib\/data\.ts:182/);
  assert.match(text, /Problem: Unbounded loop/);
  assert.match(text, /Fix: Bound the span\./);
  assert.doesNotMatch(text, /[{}"]/);
  assert.equal(formatFindings([]), 'none');
});

test('status is a readable report with phase, reason, checks, fix passes and findings', () => {
  const text = formatStatus({
    id: 'run-1', phase: 'incomplete', round: 2, maxReviews: 4, reason: 'No outstanding blocker/major findings in the inspected files. 1 selected file(s) unavailable; see omissions.',
    issues: [], files: ['a.ts', 'b.ts'], baseSha: 'abc1234', checks: [{ fingerprint: 'f', results: [{ command: 'npm test', exitCode: 0 }] }],
    history: [{ round: 1, review: { issues: [issue] }, fix: { summary: 'Bounded the span.', disputed: [] } }, { round: 2, review: { issues: [] } }],
    omissions: [{ path: 'big.csv', reason: 'too large' }],
  });
  assert.match(text, /INCOMPLETE/);
  assert.match(text, /Reviews: 2\/4/);
  assert.match(text, /npm test: exit 0/);
  assert.match(text, /Round 1 fix: Bounded the span\./);
  assert.match(text, /big\.csv: too large/);
  assert.doesNotMatch(text, /"phase"|\{\s*"/);
});

test('an interrupted review still shows its submitted findings, marked unverified', () => {
  const text = formatStatus({
    id: 'run-2', phase: 'stopped', round: 1, maxReviews: 4, reason: 'reviewer turn had an incomplete result or unrecovered tool error.',
    issues: [], history: [], submission: { complete: true, issues: [issue], limitations: [], assumptions: [], resolutions: [] },
  });
  assert.match(text, /Unverified findings from the interrupted review/);
  assert.match(text, /\[major\] R1 lib\/data\.ts:182/);
});

test('degraded reviews are labelled with their cause in status', () => {
  const text = formatStatus({
    id: 'run-3', phase: 'incomplete', round: 2, maxReviews: 4, issues: [],
    history: [{ round: 1, review: { issues: [issue] }, degraded: { cause: 'timeout' } }, { round: 2, review: { issues: [] }, degraded: { cause: 'length' } }],
  });
  assert.match(text, /Round 1 review degraded \(timeout\): findings accepted, no PASS possible from this round\./);
  assert.match(text, /Round 2 review degraded \(length\)/);
});
