import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitScope } from './git.mjs';

export async function prepare(directory, options) {
  const scope = await GitScope.open(directory, options.base);
  const snapshot = await scope.snapshot();
  if (!snapshot.files.length) throw new Error('No changes in the selected scope. Use --base main to review committed branch changes.');
  const checks = [];
  try {
    const path = join(scope.cwd, 'package.json'), stat = await lstat(path);
    if (stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Package check discovery needs a small regular package.json.');
    const scripts = JSON.parse(await readFile(path, 'utf8')).scripts ?? {};
    if (scripts.test) checks.push('npm test');
    if (scripts.lint) checks.push('npm run lint');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { scope, snapshot, checks };
}
