import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isCheckControlPath } from './check-policy.mjs';

const exec = promisify(execFile);
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_REVIEW_BYTES = 192 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const MAX_SOURCE_FILE_BYTES = 512 * 1024;
const MAX_SOURCE_RESPONSE_BYTES = 32 * 1024;
export const sensitivePath = (file) => /(^|\/)(\.env($|\.)|\.git($|\/)|id_(rsa|ed25519)$)|\.(pem|key|p12|pfx)$/i.test(file);

async function git(cwd, args) {
  try {
    const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return stdout;
  } catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Git output exceeds the 8 MiB safety budget; split the change or review it manually.');
    throw error;
  }
}
const paths = (value) => value.split('\0').filter(Boolean);
async function branchName(root) {
  try { return (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim(); }
  catch (error) { if (error.code === 1) return null; throw error; }
}

export class GitScope {
  static async open(directory, base) {
    if (!base || base.startsWith('-')) throw new Error('Invalid base ref.');
    const root = await realpath((await git(directory, ['rev-parse', '--show-toplevel'])).trim());
    const cwd = await realpath(directory);
    const baseCommit = (await git(root, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
    const baseSha = (await git(root, ['merge-base', 'HEAD', baseCommit])).trim();
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    const branch = await branchName(root);
    return new GitScope({ root, cwd, baseSha, head, branch });
  }

  constructor(info) { Object.assign(this, info); }

  async contains(path) {
    const candidate = resolve(this.cwd, path);
    const rel = relative(this.root, candidate);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || sensitivePath(rel)) return false;
    let existing = this.root;
    for (const component of rel.split(sep).filter(Boolean)) {
      existing = join(existing, component);
      try {
        if ((await lstat(existing)).isSymbolicLink()) return false;
      } catch (error) {
        if (error.code !== 'ENOENT') return false;
      }
    }
    return true;
  }

  async canEdit(path) {
    if (!await this.contains(path)) return false;
    const file = relative(this.root, resolve(this.cwd, path)).split(sep).join('/');
    if (isCheckControlPath(file)) return false;
    if (/(^|\/)(AGENTS\.md|CLAUDE\.md|\.opencode|\.claude|\.cursor|\.agents|node_modules|\.gitignore|\.gitattributes)($|\/)/i.test(file)) return false;
    try { await git(this.root, ['check-ignore', '--quiet', '--', file]); return false; }
    catch (error) { if (error.code === 1) return true; throw error; }
  }

  async source({ operation, path = '', query = '', offset = 1, limit = 150 }) {
    if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid source pagination.');
    const files = [...new Set(paths(await git(this.root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])))].filter((file) => !sensitivePath(file)).sort();
    if (operation === 'list') return files.slice(offset - 1, offset - 1 + limit).join('\n') + `\n(${files.length} source paths total; paginate with offset/limit)`;
    if (!['read', 'search'].includes(operation)) throw new Error('Use list, read, or search.');
    if (operation === 'read' && (!files.includes(path) || path.includes('\\'))) throw new Error('Path is not an allowed source file.');
    if (operation === 'search' && (typeof query !== 'string' || !query || query.length > 200)) throw new Error('Provide a literal search query of 1–200 characters.');
    const output = [];
    let matches = 0, bytes = 0, scanned = 0;
    for (const file of operation === 'read' ? [path] : files) {
      const absolute = join(this.root, file);
      let stat;
      try { stat = await lstat(absolute); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_FILE_BYTES) {
        if (operation === 'read') throw new Error('Source is a symlink, non-file, or exceeds the file budget.');
        continue;
      }
      if (!await this.contains(absolute)) {
        if (operation === 'search') continue;
        throw new Error('Source path escapes the worktree.');
      }
      scanned += stat.size;
      if (scanned > MAX_SOURCE_BYTES) throw new Error('Search exceeded source budget.');
      const content = await readFile(absolute, 'utf8');
      if (content.includes('\0')) { if (operation === 'read') throw new Error('Binary source is unsupported.'); continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (operation === 'read' || lines[i].includes(query)) {
          matches += 1;
          if (matches < offset) continue;
          const line = `${file}:${i + 1}: ${lines[i]}`;
          bytes += Buffer.byteLength(line);
          if (output.length >= limit || bytes > MAX_SOURCE_RESPONSE_BYTES) return output.join('\n') + '\n[More source/matches available; paginate.]';
          output.push(line);
        }
      }
    }
    return output.join('\n') || '[No matching source lines.]';
  }

  async snapshot() {
    const head = (await git(this.root, ['rev-parse', 'HEAD'])).trim();
    const branch = await branchName(this.root);
    if (head !== this.head || branch !== this.branch) throw new Error('Branch or HEAD changed; start a new run.');
    const added = paths(await git(this.root, ['ls-files', '--others', '--exclude-standard', '-z']));
    const changed = paths(await git(this.root, ['diff', '--name-only', '--no-renames', '-z', this.baseSha, '--']));
    const files = [...new Set([...changed, ...added])].sort();
    // The encoded --binary fingerprint below is against HEAD; reject binary changes before buffering it.
    const stats = paths(await git(this.root, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--']));
    if (stats.some((entry) => entry.startsWith('-\t-\t'))) throw new Error('Binary changes need manual review; no binary diff was buffered.');
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
    // HEAD is pinned: Git's binary working diff identifies all tracked changes,
    // including files outside the review diff. Unchanged assets need not be reread in JS.
    hash.update(await git(this.root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--']));
    let bytes = 0;
    for (const file of added.sort()) {
      hash.update(file).update('\0');
      try {
        const stat = await lstat(join(this.root, file));
        hash.update(String(stat.mode));
        if (stat.isSymbolicLink()) hash.update(await readlink(join(this.root, file)));
        else if (stat.isFile()) {
          const canonical = await realpath(join(this.root, file));
          const rel = relative(this.root, canonical);
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Tracked source path escapes the worktree.');
          bytes += stat.size;
          if (bytes > MAX_SOURCE_BYTES) throw new Error('Source exceeds the supported fingerprint budget.');
          hash.update(`${stat.size}\0`).update(await readFile(canonical));
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
