import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const exec = promisify(execFile);
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_REVIEW_BYTES = 192 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
export const sensitivePath = (file) => /(^|\/)(\.env($|\.)|\.git($|\/)|id_(rsa|ed25519)$)|\.(pem|key|p12|pfx)$/i.test(file);

async function git(cwd, args) {
  const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout;
}
const paths = (value) => value.split('\0').filter(Boolean);

export class GitScope {
  static async open(directory, base) {
    if (!base || base.startsWith('-')) throw new Error('Invalid base ref.');
    const root = await realpath((await git(directory, ['rev-parse', '--show-toplevel'])).trim());
    const cwd = await realpath(directory);
    const baseCommit = (await git(root, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
    const baseSha = (await git(root, ['merge-base', 'HEAD', baseCommit])).trim();
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    const branch = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    return new GitScope({ root, cwd, baseSha, head, branch });
  }

  constructor(info) { Object.assign(this, info); }

  async snapshot() {
    const head = (await git(this.root, ['rev-parse', 'HEAD'])).trim();
    const branch = (await git(this.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    if (head !== this.head || branch !== this.branch) throw new Error('Branch or HEAD changed; start a new run.');
    const tracked = paths(await git(this.root, ['ls-files', '-z']));
    const added = paths(await git(this.root, ['ls-files', '--others', '--exclude-standard', '-z']));
    const changed = paths(await git(this.root, ['diff', '--name-only', '--no-renames', '-z', this.baseSha, '--']));
    const files = [...new Set([...changed, ...added])].sort();
    for (const file of files) {
      if (sensitivePath(file)) throw new Error(`Sensitive changed path cannot be reviewed: ${file}`);
      try {
        const stat = await lstat(join(this.root, file));
        if (stat.isSymbolicLink()) throw new Error(`Changed symlink is unsupported: ${file}`);
        if (!stat.isFile()) throw new Error(`Changed non-file/submodule is unsupported: ${file}`);
        const canonical = await realpath(join(this.root, file));
        if (relative(this.root, canonical).startsWith(`..${sep}`)) throw new Error('Changed path escapes the worktree.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const hash = createHash('sha256').update(`${head}\0${branch}\0`);
    let bytes = 0;
    for (const file of [...new Set([...tracked, ...added])].sort()) {
      hash.update(file).update('\0');
      try {
        const stat = await lstat(join(this.root, file));
        hash.update(String(stat.mode));
        if (stat.isSymbolicLink()) hash.update(await readlink(join(this.root, file)));
        else if (stat.isFile()) {
          bytes += stat.size;
          if (bytes > MAX_SOURCE_BYTES) throw new Error('Source exceeds the supported fingerprint budget.');
          hash.update(await readFile(join(this.root, file)));
        } else throw new Error(`Tracked non-file/submodule is unsupported: ${file}`);
      } catch (error) { if (error.code === 'ENOENT') hash.update('deleted'); else throw error; }
      hash.update('\0');
    }
    const index = createHash('sha256').update(await git(this.root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--'])).digest('hex');
    let diff = await git(this.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', this.baseSha, '--']);
    if (/^Binary files .* differ$/m.test(diff)) throw new Error('Binary changes need manual review.');
    for (const file of added.sort()) {
      const content = await readFile(join(this.root, file), 'utf8');
      if (content.includes('\0')) throw new Error('Binary new files need manual review.');
      diff += `\nNew file ${JSON.stringify(file)}:\n${content}\n`;
    }
    if (Buffer.byteLength(diff) > MAX_REVIEW_BYTES) throw new Error('Diff exceeds the supported review budget; split the change.');
    return { fingerprint: hash.digest('hex'), files, diff, index };
  }
}
