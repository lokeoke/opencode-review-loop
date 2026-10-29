import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { install } from '../scripts/install.mjs';

test('one global loader imports the plugin without changing user config and can be removed safely', async (t) => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'opencode-review-loop-install-'));
  t.after(() => rm(configDirectory, { recursive: true, force: true }));
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const config = join(configDirectory, 'opencode.json');
  await writeFile(config, '{"shell":"/bin/zsh","unrelated":true}');
  const path = await install({ configDirectory, sourceRoot });
  assert.equal((await import(pathToFileURL(path).href)).default.id, 'review-loop');
  assert.equal(await readFile(config, 'utf8'), '{"shell":"/bin/zsh","unrelated":true}');
  await install({ configDirectory, sourceRoot });
  await install({ configDirectory, sourceRoot, uninstall: true });
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('installation does not overwrite an unfamiliar loader', async (t) => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'opencode-review-loop-collision-'));
  t.after(() => rm(configDirectory, { recursive: true, force: true }));
  await mkdir(join(configDirectory, 'plugins'));
  const path = join(configDirectory, 'plugins/review-loop.js');
  await writeFile(path, 'user work');
  await assert.rejects(install({ configDirectory, sourceRoot: process.cwd() }), /unfamiliar/i);
  assert.equal(await readFile(path, 'utf8'), 'user work');
});
