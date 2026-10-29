import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

const CONTROL_NAMES = new Set([
  'package.json', '.npmrc', 'Makefile', 'makefile', 'GNUmakefile', 'pyproject.toml', 'setup.cfg', 'setup.py', 'tox.ini', 'pytest.ini', 'conftest.py', 'noxfile.py',
  'jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.ts',
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs',
  'tsconfig.json', 'babel.config.js', '.babelrc', 'playwright.config.js', 'playwright.config.ts', 'pom.xml', 'build.gradle', 'go.mod',
]);
const CONTROL_NAMES_LOWERCASE = new Set([...CONTROL_NAMES].map((name) => name.toLowerCase()));
const MAX_CONTROL_BYTES = 1024 * 1024;
export const isCheckControlPath = (file) => CONTROL_NAMES_LOWERCASE.has(basename(file).toLowerCase());

// Protect these names repo-wide from automatic edits; fingerprint them from the check directory to the worktree root.
// This freezes known launch definitions, not arbitrary transitive code executed by checks.
export async function checkPolicyFingerprint(scope) {
  const hash = createHash('sha256');
  for (let directory = scope.cwd; ; directory = dirname(directory)) {
    for (const name of CONTROL_NAMES) {
      const path = join(directory, name);
      hash.update(relative(scope.root, path)).update('\0');
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTROL_BYTES || !await scope.contains(path)) throw new Error('Check control file is not a small regular in-worktree file.');
        const content = await readFile(path);
        hash.update(`file:${content.length}\0`).update(content);
      } catch (error) { if (error.code === 'ENOENT') hash.update('missing\0'); else throw error; }
      hash.update('\0');
    }
    if (directory === scope.root) break;
    if (dirname(directory) === directory) throw new Error('Check directory is outside the worktree.');
  }
  return hash.digest('hex');
}
