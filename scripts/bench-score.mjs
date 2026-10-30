import { execFileSync } from 'node:child_process';
import { cp, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FIXTURES = new URL('../bench/fixtures/', import.meta.url).pathname;
const GIT_IDENTITY = ['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.invalid'];

export function validateFixture(name, value) {
  if (typeof value?.check !== 'string' || !value.check.trim()) throw new Error(`Fixture ${name} needs a check command.`);
  if (!Array.isArray(value.defects)) throw new Error(`Fixture ${name} needs a defects list.`);
  for (const defect of value.defects) {
    if (!defect.id || !Array.isArray(defect.locations) || !defect.locations.length) throw new Error(`Fixture ${name} defect ${defect.id} needs a location.`);
    for (const { file, lines } of defect.locations) {
      if (typeof file !== 'string' || !Array.isArray(lines) || lines.length !== 2 || !(lines[0] >= 1 && lines[0] <= lines[1])) throw new Error(`Fixture ${name} defect ${defect.id} has invalid lines.`);
    }
  }
  return { name, ...value };
}

export async function loadFixtures(root = FIXTURES) {
  const entries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(entries.map(async ({ name }) => ({ ...validateFixture(name, JSON.parse(await readFile(join(root, name, 'fixture.json'), 'utf8'))), path: join(root, name) })));
}

// Builds the fixture in an empty directory: committed base plus the uncommitted change,
// or, for a git fixture, a clone of this repository detached at the recorded head.
export async function materialize(fixture, directory, repository) {
  const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
  if (fixture.git) {
    execFileSync('git', ['clone', '--quiet', repository, directory], { stdio: 'ignore' });
    git('checkout', '--quiet', '--detach', fixture.git.head);
    return;
  }
  await cp(join(fixture.path, 'base'), directory, { recursive: true });
  git('init', '--quiet', '-b', 'main');
  git('add', '.');
  git(...GIT_IDENTITY, 'commit', '--quiet', '-m', 'Fixture base');
  await cp(join(fixture.path, 'change'), directory, { recursive: true, force: true });
}

const within = (location, file, line) => location.file === file && line >= location.lines[0] && line <= location.lines[1];
const anchors = (finding) => [finding, finding.introduced_by].filter((anchor) => anchor?.file && Number.isInteger(anchor.line));

export function score(fixture, findings) {
  const caught = new Set();
  const unmatched = [];
  for (const finding of findings) {
    const hits = fixture.defects.filter((defect) => defect.locations.some((location) => anchors(finding).some(({ file, line }) => within(location, file, line))));
    hits.forEach((defect) => caught.add(defect.id));
    if (!hits.length) unmatched.push(finding);
  }
  const ids = fixture.defects.map((defect) => defect.id);
  return { caught: ids.filter((id) => caught.has(id)), missed: ids.filter((id) => !caught.has(id)), unmatched };
}

// Free-form reviewers are asked to end with a ```json array; earlier blocks are drafts.
export function extractFindings(text) {
  const blocks = [...String(text).matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (!blocks.length) return undefined;
  try {
    const value = JSON.parse(blocks.at(-1)[1]);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
