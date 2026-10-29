import { GitScope } from '../src/git.mjs';
import { RunStore } from '../src/storage.mjs';

try {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/status.mjs [project-directory]');
  const scope = await GitScope.open(process.argv[2] || process.cwd(), 'HEAD');
  const state = await new RunStore().read(scope.root);
  console.log(state ? JSON.stringify(state, null, 2) : 'No review loop recorded for this worktree.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
