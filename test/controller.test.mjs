import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Run } from '../src/controller.mjs';

const finding = { id: 'auth-check', severity: 'major', file: 'app.js', line: 2, problem: 'Missing authorization', failure_scenario: 'A guest can delete another user.', suggested_fix: 'Check the owner.' };

test('a clean review passes only after successful checks and a completed reviewer turn', () => {
  const run = new Run({ id: 'run-1', maxReviews: 4 });
  run.checked('sha-1');
  run.submitReview({ complete: true, limitations: [], assumptions: [], issues: [], resolutions: [] });
  assert.equal(run.state.phase, 'reviewing');
  run.reviewCompleted('sha-1');
  assert.equal(run.state.phase, 'passed');
});

test('omitting an old blocking finding never proves that it was fixed', () => {
  const run = new Run({ id: 'run-3' });
  run.checked('before');
  run.submitReview({ complete: true, limitations: [], assumptions: [], issues: [finding], resolutions: [] });
  run.reviewCompleted('before');
  run.submitFix({ summary: 'Attempted fix', disputed: [] });
  run.fixCompleted();
  run.checked('after');
  run.submitReview({ complete: true, limitations: [], assumptions: [], issues: [], resolutions: [] });
  run.reviewCompleted('after');
  assert.equal(run.state.phase, 'stopped');
  assert.match(run.state.reason, /resolution/i);
});

test('the last available review never schedules another fix', () => {
  const run = new Run({ id: 'run-4', maxReviews: 1 });
  run.checked('before');
  run.submitReview({ complete: true, limitations: [], assumptions: [], issues: [finding], resolutions: [] });
  run.reviewCompleted('before');
  assert.equal(run.state.phase, 'stopped');
  assert.match(run.state.reason, /limit/i);
});

test('invalid findings and late submissions cannot advance a run', () => {
  const run = new Run({ id: 'run-5' });
  run.checked('before');
  assert.throws(() => run.submitReview({ complete: true, limitations: [], assumptions: [], issues: [{ ...finding, severity: 'whatever' }], resolutions: [] }), /severity/i);
  run.stop('Cancelled');
  assert.throws(() => run.submitReview({ complete: true, limitations: [], assumptions: [], issues: [], resolutions: [] }), /stopped/);
  assert.equal(run.state.reason, 'Cancelled');
});

test('the same blocking findings twice require human takeover', () => {
  const run = new Run({ id: 'run-6' });
  run.checked('before');
  run.submitReview({ complete: true, limitations: [], assumptions: [], issues: [finding], resolutions: [] });
  run.reviewCompleted('before');
  run.submitFix({ summary: 'Attempted fix', disputed: [] });
  run.fixCompleted();
  run.checked('after');
  run.submitReview({ complete: true, limitations: [], assumptions: [], issues: [finding], resolutions: [{ id: finding.id, status: 'open', evidence: 'The guest path still bypasses the check.' }] });
  run.reviewCompleted('after');
  assert.match(run.state.reason, /progress/i);
});

test('code mutation during review and returning to an earlier fingerprint stop the run', () => {
  const run = new Run({ id: 'run-7' });
  run.checked('before');
  run.submitReview({ complete: true, limitations: [], assumptions: [], issues: [], resolutions: [] });
  run.reviewCompleted('changed');
  assert.equal(run.state.phase, 'stopped');
  const cycle = new Run({ id: 'run-8' });
  cycle.checked('before');
  cycle.submitReview({ complete: true, limitations: [], assumptions: [], issues: [finding], resolutions: [] });
  cycle.reviewCompleted('before');
  cycle.submitFix({ summary: 'No change', disputed: [] });
  cycle.fixCompleted();
  cycle.checked('before');
  assert.match(cycle.state.reason, /progress|oscillation/i);
});

test('a supported finding can be fixed and explicitly resolved on re-review', () => {
  const run = new Run({ id: 'run-2' });
  run.checked('before');
  run.submitReview({ complete: true, limitations: [], assumptions: [], issues: [finding], resolutions: [] });
  run.reviewCompleted('before');
  assert.equal(run.state.phase, 'fixing');
  run.submitFix({ summary: 'Added ownership check and regression test.', disputed: [] });
  run.fixCompleted();
  run.checked('after');
  run.submitReview({ complete: true, limitations: [], assumptions: [], issues: [], resolutions: [{ id: 'auth-check', status: 'fixed', evidence: 'app.js now checks the owner before deletion.' }] });
  run.reviewCompleted('after');
  assert.equal(run.state.phase, 'passed');
});

const minor = { ...finding, id: 'empty-input', severity: 'minor', problem: 'Empty input returns undefined.' };
const review = (issues, resolutions = []) => ({ complete: true, limitations: [], assumptions: [], issues, resolutions });

test('a new minor finding gets one fix pass, and a repeated one no longer holds the run', () => {
  const run = new Run({ id: 'run-minor' });
  run.checked('before');
  run.submitReview(review([minor]));
  run.reviewCompleted('before');
  assert.equal(run.state.phase, 'fixing');
  run.submitFix({ summary: 'Handled empty input.', disputed: [] });
  run.fixCompleted();
  run.checked('after');
  run.submitReview(review([minor]));
  run.reviewCompleted('after');
  assert.equal(run.state.phase, 'passed');
  assert.deepEqual(run.state.issues.map((issue) => issue.id), ['empty-input']);
});

test('minor findings on the last available review are reported without another fix', () => {
  const run = new Run({ id: 'run-minor-limit', maxReviews: 1 });
  run.checked('before');
  run.submitReview(review([minor]));
  run.reviewCompleted('before');
  assert.equal(run.state.phase, 'passed');
});

test('a disputed minor finding is recorded without stopping; a disputed blocker still stops', () => {
  const minorRun = new Run({ id: 'run-minor-dispute' });
  minorRun.checked('before');
  minorRun.submitReview(review([minor]));
  minorRun.reviewCompleted('before');
  minorRun.submitFix({ summary: 'Input cannot be empty here.', disputed: ['empty-input'] });
  minorRun.fixCompleted();
  assert.equal(minorRun.state.phase, 'checking');
  assert.deepEqual(minorRun.state.history.at(-1).fix.disputed, ['empty-input']);
  const blockerRun = new Run({ id: 'run-blocker-dispute' });
  blockerRun.checked('before');
  blockerRun.submitReview(review([finding, minor]));
  blockerRun.reviewCompleted('before');
  blockerRun.submitFix({ summary: 'Disagree.', disputed: ['auth-check'] });
  blockerRun.fixCompleted();
  assert.equal(blockerRun.state.phase, 'stopped');
});

test('a minor-only fix pass that leaves the code unchanged passes instead of stopping as oscillation', () => {
  const run = new Run({ id: 'run-minor-unchanged' });
  run.checked('same');
  run.submitReview(review([minor]));
  run.reviewCompleted('same');
  run.submitFix({ summary: 'Input cannot be empty here.', disputed: ['empty-input'] });
  run.fixCompleted();
  run.checked('same');
  assert.equal(run.state.phase, 'passed');
  const blocked = new Run({ id: 'run-blocker-unchanged' });
  blocked.checked('same');
  blocked.submitReview(review([finding]));
  blocked.reviewCompleted('same');
  blocked.submitFix({ summary: 'Attempted fix', disputed: [] });
  blocked.fixCompleted();
  blocked.checked('same');
  assert.equal(blocked.state.phase, 'stopped');
});
