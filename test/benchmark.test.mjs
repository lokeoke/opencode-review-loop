import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURES, extractFindings, loadFixtures, materialize, score } from '../scripts/bench-score.mjs';

const fixture = {
  defects: [
    { id: 'a', locations: [{ file: 'x.mjs', lines: [5, 6] }] },
    { id: 'b', locations: [{ file: 'y.mjs', lines: [1, 1] }, { file: 'x.mjs', lines: [9, 9] }] },
  ],
};

test('a finding catches a defect only when its file matches and its line is in range', () => {
  const result = score(fixture, [
    { file: 'x.mjs', line: 6, problem: 'in range' },
    { file: 'x.mjs', line: 7, problem: 'outside every range' },
    { file: 'z.mjs', line: 5, problem: 'other file' },
  ]);
  assert.deepEqual(result.caught, ['a']);
  assert.deepEqual(result.missed, ['b']);
  assert.deepEqual(result.unmatched.map((finding) => finding.problem), ['outside every range', 'other file']);
});

test('any location of a defect counts, including an introduced_by anchor', () => {
  const result = score(fixture, [{ file: 'q.mjs', line: 1, introduced_by: { file: 'x.mjs', line: 9 } }]);
  assert.deepEqual(result.caught, ['b']);
  assert.deepEqual(result.unmatched, []);
});

test('a clean fixture reports every finding as unmatched', () => {
  const result = score({ defects: [] }, [{ file: 'x.mjs', line: 1 }]);
  assert.deepEqual(result.caught, []);
  assert.equal(result.unmatched.length, 1);
});

test('findings are read from the last json block of free-form review text', () => {
  const text = 'Notes\n```json\n[{"file":"old.mjs","line":1}]\n```\nFinal:\n```json\n[{"file":"x.mjs","line":5,"severity":"major","problem":"p"}]\n```\n';
  assert.deepEqual(extractFindings(text), [{ file: 'x.mjs', line: 5, severity: 'major', problem: 'p' }]);
  assert.equal(extractFindings('no block here'), undefined);
  assert.equal(extractFindings('```json\nnot json\n```'), undefined);
});

test('every bundled fixture is well formed and its seeded defects survive its own check', async (t) => {
  const fixtures = await loadFixtures(FIXTURES);
  assert.ok(fixtures.length >= 7);
  for (const item of fixtures.filter((entry) => !entry.git)) {
    const directory = await mkdtemp(join(tmpdir(), 'review-loop-bench-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await materialize(item, directory);
    for (const defect of item.defects) {
      for (const { file, lines: [first, last] } of defect.locations) {
        const length = (await readFile(join(directory, file), 'utf8')).split('\n').length;
        assert.ok(first >= 1 && first <= last && last <= length, `${item.name}/${defect.id} range is outside ${file}`);
      }
    }
    // The check passes on the defective change: tests alone cannot catch the seeded defects.
    execFileSync('sh', ['-c', item.check], { cwd: directory, stdio: 'ignore' });
    assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: directory, encoding: 'utf8' }), /\S/, `${item.name} has no uncommitted change`);
  }
});

test('fixtures with missing check or malformed defects are rejected', async () => {
  const { validateFixture } = await import('../scripts/bench-score.mjs');
  assert.throws(() => validateFixture('bad', { defects: [] }), /check/);
  assert.throws(() => validateFixture('bad', { check: 'x', defects: [{ id: 'd', locations: [{ file: 'a', lines: [3, 1] }] }] }), /lines/);
  assert.throws(() => validateFixture('bad', { check: 'x', defects: [{ id: 'd', locations: [] }] }), /location/);
});
