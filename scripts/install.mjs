import { mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const MARKER = '// Managed by opencode-review-loop installer v1\n';

export async function install({
  configDirectory = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode'),
  sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  uninstall = false,
} = {}) {
  const path = join(configDirectory, 'plugins/review-loop.js');
  let existing;
  try { existing = await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing !== undefined && !existing.startsWith(MARKER)) throw new Error('Refusing to overwrite an unfamiliar review-loop.js loader.');
  const directory = join(configDirectory, 'plugins/review-loop');
  const entryPath = join(directory, 'index.js');
  for (const file of ['index.js', 'tui.js', 'gui-experimental.cjs', 'package.json']) {
    try {
      const content = await readFile(join(directory, file), 'utf8');
      if (file === 'package.json' ? JSON.parse(content).name !== 'opencode-review-loop-global-loader' : !content.startsWith(MARKER)) throw new Error('Refusing to overwrite unfamiliar review-loop package files.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (uninstall) {
    if (existing !== undefined) await rm(path);
    for (const file of ['index.js', 'tui.js', 'gui-experimental.cjs', 'package.json']) await rm(join(directory, file), { force: true });
    try { await rmdir(directory); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
    return entryPath;
  }
  const entry = await realpath(join(sourceRoot, 'src/index.mjs'));
  const tui = await realpath(join(sourceRoot, 'src/tui.mjs'));
  await mkdir(directory, { recursive: true });
  for (const [file, content] of [
    ['index.js', `${MARKER}export { default } from ${JSON.stringify(pathToFileURL(entry).href)};\n`],
    ['tui.js', `${MARKER}export { default } from ${JSON.stringify(pathToFileURL(tui).href)};\n`],
    ['gui-experimental.cjs', MARKER + await readFile(join(sourceRoot, 'dist/gui-experimental.cjs'), 'utf8')],
    ['package.json', JSON.stringify({ name: 'opencode-review-loop-global-loader', type: 'module', exports: { '.': './index.js', './tui': './tui.js', './gui-experimental': './gui-experimental.cjs' } })],
  ]) {
    const target = join(directory, file), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  }
  if (existing !== undefined) await rm(path);
  return entryPath;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--uninstall')) throw new Error('Usage: node scripts/install.mjs [--uninstall]');
    console.log(`${args.includes('--uninstall') ? 'Removed' : 'Installed'} global loader: ${await install({ uninstall: args.includes('--uninstall') })}`);
    console.log('OpenCode watches global plugins. Use /reload if the commands have not refreshed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
