import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitScope } from './git.mjs';
import { checkPolicyFingerprint } from './check-policy.mjs';

const MAX_LISTED_EXTRAS = 10;

export async function inspectScope(directory, options) {
  const scope = await GitScope.open(directory, options.base);
  const snapshot = await scope.snapshot();
  if (!snapshot.files.length) throw new Error('No changes in the selected scope. Use --base main to review committed branch changes.');
  if (options.pullRequest && !options.includeUncommitted) {
    const extra = await scope.uncommitted();
    if (extra.length) {
      const shown = extra.slice(0, MAX_LISTED_EXTRAS).join(', ') + (extra.length > MAX_LISTED_EXTRAS ? `, and ${extra.length - MAX_LISTED_EXTRAS} more` : '');
      throw new Error(`This checkout has uncommitted changes that are not part of pull request #${options.pullRequest.number}: ${shown}. Commit, stash or discard them, or pass --include-uncommitted to review them too.`);
    }
  }
  return { scope, snapshot };
}

export async function prepare(directory, options) {
  const { scope, snapshot } = await inspectScope(directory, options);
  const checks = [];
  const definitions = [];
  try {
    const path = join(scope.cwd, 'package.json'), stat = await lstat(path);
    if (stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Package check discovery needs a small regular package.json.');
    const scripts = JSON.parse(await readFile(path, 'utf8')).scripts ?? {};
    for (const [name, command] of [['test', 'npm test'], ['lint', 'npm run lint']]) {
      if (typeof scripts[name] !== 'string' || !scripts[name].trim()) continue;
      checks.push(command);
      for (const hook of [`pre${name}`, name, `post${name}`]) if (typeof scripts[hook] === 'string') definitions.push(`${hook}: ${scripts[hook]}`);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { scope, snapshot, checks, definitions, checkPolicy: await checkPolicyFingerprint(scope) };
}
