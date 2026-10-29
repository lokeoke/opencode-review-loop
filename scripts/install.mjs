import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
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
  if (uninstall) {
    if (existing !== undefined) await rm(path);
    return path;
  }
  const entry = await realpath(join(sourceRoot, 'src/index.mjs'));
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${MARKER}export { default } from ${JSON.stringify(pathToFileURL(entry).href)};\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  return path;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--uninstall')) throw new Error('Usage: node scripts/install.mjs [--uninstall]');
    console.log(`${args.includes('--uninstall') ? 'Removed' : 'Installed'} global loader: ${await install({ uninstall: args.includes('--uninstall') })}`);
    console.log('OpenCode watches global plugins. Use /reload if the commands have not refreshed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
