import { GitScope } from '../src/git.mjs';
import { RunStore } from '../src/storage.mjs';

try {
  const [directory, runID, confirmation] = process.argv.slice(2);
  if (!directory || !runID || confirmation !== '--confirm-processes-stopped' || process.argv.length !== 5) throw new Error('Usage: node scripts/recover.mjs PROJECT RUN_ID --confirm-processes-stopped\nFirst verify all old run/check processes have stopped.');
  const scope = await GitScope.open(directory, 'HEAD');
  console.log(`Archived stale claim: ${await new RunStore().recover(scope.root, runID, { processesStopped: true })}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
