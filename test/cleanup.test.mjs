import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Engine } from '../src/engine.mjs';

test('stop never sends a signal to a recorded process-group number after failed cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-review-loop-uncertain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-b', 'main');
  await writeFile(join(root, 'app.js'), 'before');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial');
  await writeFile(join(root, 'app.js'), 'after');
  const model = { providerID: 'github-copilot', id: 'gpt-6.1-sol' };
  const engine = new Engine({
    model: { list: async () => [{ providerID: 'github-copilot', id: 'claude-sonnet-5.5', capabilities: { tools: true } }] },
    session: {
      get: async () => ({ agent: 'build', model, location: { directory: root } }),
      wait: async () => {}, synthetic: async () => {},
    },
  }, { stateDirectory: join(root, '.git/state') });
  const kill = t.mock.method(process, 'kill', () => { throw Object.assign(new Error('Cleanup refused'), { code: 'EPERM' }); });
  const task = await engine.start('uncertain-fixer', { base: 'HEAD', checks: ['exit 0'] });
  await task.done;
  assert.ok((await engine.status('uncertain-fixer')).pendingProcessPID);
  const before = kill.mock.callCount();
  await assert.rejects(engine.stop('uncertain-fixer'), /never signalled again/);
  assert.equal(kill.mock.callCount(), before);
  // The intentionally retained claim is isolated in this test process and owned temp directory.
});
