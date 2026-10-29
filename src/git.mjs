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
const MAX_REVIEW_FILES = 300;
const MAX_DIFF_LINE_CHARS = 4000;
export const END_OF_DIFF = '(end of diff)';
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

// Long lines are delivered in full as consecutive chunks, so reaching the end always means everything was returned.
function splitDiffLines(text) {
  return text.split('\n').flatMap((line) => {
    const chunks = [];
    for (let start = 0; start < line.length;) {
      let end = Math.min(start + MAX_DIFF_LINE_CHARS, line.length);
      const last = line.charCodeAt(end - 1);
      if (end < line.length && last >= 0xd800 && last <= 0xdbff) end -= 1; // never split a surrogate pair
      chunks.push(line.slice(start, end));
      start = end;
    }
    return chunks.length ? chunks : [''];
  });
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
    // Keep the directory exactly as OpenCode reports it: resource paths are relative to it, not to its canonical form.
    return new GitScope({ root, cwd, sessionDirectory: resolve(directory), baseSha, head, branch });
  }

  constructor(info) { Object.assign(this, info); this.diffCache = new Map(); }

  // Drop cached diffs and path lists; call whenever the working tree may have changed (a snapshot, or any model turn).
  invalidate() { this.diffCache.clear(); this.pathsCache = undefined; }

  // Resource paths are relative to the session directory as OpenCode reports it. Resolve them lexically there,
  // then map anything under that directory onto its canonical form. Deliberately no realpath on the result:
  // following a symlink component inside the worktree would defeat the symlink rejection below.
  resolveResource(path) {
    const session = this.sessionDirectory ?? this.cwd;
    const candidate = resolve(session, path);
    const inside = relative(session, candidate);
    return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? candidate : resolve(this.cwd, inside);
  }

  async contains(path) {
    const candidate = this.resolveResource(path);
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

  // Paths whose working-tree state differs from the pinned HEAD: tracked edits plus untracked, non-ignored files.
  async uncommitted() {
    const tracked = paths(await git(this.root, ['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--']));
    const added = paths(await git(this.root, ['ls-files', '--others', '--exclude-standard', '-z']));
    return [...new Set([...tracked, ...added])].sort();
  }

  // Returns why an automatic edit of this path is refused, or undefined when allowed. Never throws:
  // an unclassifiable path is a visible, specific denial rather than a silent one.
  async editDenial(path) {
    if (!await this.contains(path)) return 'outside the worktree, through a symlink component, or a sensitive path';
    const file = relative(this.root, this.resolveResource(path)).split(sep).join('/');
    if (!file) return 'the worktree root is a directory, not an editable file';
    if (isCheckControlPath(file)) return 'protected check/launch control file';
    if (/(^|\/)(AGENTS\.md|CLAUDE\.md|\.opencode|\.claude|\.cursor|\.agents|node_modules|\.gitignore|\.gitattributes)($|\/)/i.test(file)) return 'protected agent/runtime configuration or dependency path';
    try { await git(this.root, ['check-ignore', '--quiet', '--', file]); return 'ignored by Git'; }
    catch (error) { return error.code === 1 ? undefined : `Git could not classify the path (exit ${error.code})`; }
  }

  async canEdit(path) { return (await this.editDenial(path)) === undefined; }

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

  // Changed paths in the review scope, and the subset that is untracked (so absent from `git diff`).
  async changedPaths() {
    const added = paths(await git(this.root, ['ls-files', '--others', '--exclude-standard', '-z'])).sort();
    const changed = paths(await git(this.root, ['diff', '--name-only', '--no-renames', '-z', this.baseSha, '--']));
    return { added, files: [...new Set([...changed, ...added])].sort() };
  }

  // One changed file's diff, paged by diff line, for changes too large to embed. `complete` means the end was returned.
  async fileDiff({ path, offset = 1, limit = 150 }) {
    if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid diff pagination.');
    const { added, files } = this.pathsCache ??= await this.changedPaths();
    if (typeof path !== 'string' || !files.includes(path)) throw new Error('Path is not a changed file in this review.');
    let lines = this.diffCache.get(path);
    if (!lines) {
      let text;
      if (added.includes(path)) {
        if (!await this.contains(join(this.root, path))) throw new Error('Path is not a changed file in this review.');
        const stat = await lstat(join(this.root, path));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_FILE_BYTES) throw new Error('New file cannot be read: it is not a regular file or exceeds the per-file size limit.');
        const content = await readFile(join(this.root, path), 'utf8');
        if (content.includes('\0')) throw new Error('Binary new files need manual review.');
        text = `New file ${JSON.stringify(path)}:\n${content}`;
      } else text = await git(this.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', this.baseSha, '--', path]);
      lines = splitDiffLines(text);
      this.diffCache.set(path, lines);
    }
    if (offset > lines.length) throw new Error(`Offset ${offset} is beyond the end of this diff (${lines.length} lines).`);
    const page = [];
    let bytes = 0, index = offset - 1;
    for (; index < lines.length && page.length < limit; index++) {
      const line = lines[index];
      bytes += Buffer.byteLength(line);
      if (page.length && bytes > MAX_SOURCE_RESPONSE_BYTES) break;
      page.push(line);
    }
    const complete = index >= lines.length;
    return { complete, next: index + 1, text: page.join('\n') + (complete ? `\n${END_OF_DIFF}` : `\n[More diff available; continue at offset ${index + 1}.]`) };
  }

  async snapshot() {
    const [headOut, branch] = await Promise.all([git(this.root, ['rev-parse', 'HEAD']), branchName(this.root)]);
    const head = headOut.trim();
    if (head !== this.head || branch !== this.branch) throw new Error('Branch or HEAD changed; start a new run.');
    this.invalidate();
    const [{ added, files }, numstat] = await Promise.all([
      this.changedPaths(),
      git(this.root, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--']),
    ]);
    if (files.length > MAX_REVIEW_FILES) throw new Error(`The change touches more than ${MAX_REVIEW_FILES} files; split it into smaller reviews.`);
    // The encoded --binary fingerprint below is against HEAD; reject binary changes before buffering it.
    const stats = paths(numstat);
    if (stats.some((entry) => entry.startsWith('-\t-\t'))) throw new Error('Binary changes need manual review; no binary diff was buffered.');
    for (const file of files) {
      if (sensitivePath(file)) throw new Error(`Sensitive changed path cannot be reviewed: ${file}`);
      try {
        const stat = await lstat(join(this.root, file));
        if (stat.isSymbolicLink()) throw new Error(`Changed symlink is unsupported: ${file}`);
        if (!stat.isFile()) throw new Error(`Changed non-file/submodule is unsupported: ${file}`);
        if (added.includes(file) && stat.size > MAX_SOURCE_FILE_BYTES) throw new Error(`New file is larger than ${MAX_SOURCE_FILE_BYTES / 1024} KiB and cannot be reviewed: ${file}. Commit it separately, ignore it, or split it.`);
        const canonical = await realpath(join(this.root, file));
        if (relative(this.root, canonical).startsWith(`..${sep}`)) throw new Error('Changed path escapes the worktree.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const [workingBinary, cachedBinary, baseDiff] = await Promise.all([
      git(this.root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--']),
      git(this.root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--']),
      git(this.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', this.baseSha, '--']),
    ]);
    const hash = createHash('sha256').update(`${head}\0${branch}\0`);
    // HEAD is pinned: Git's binary working diff identifies all tracked changes,
    // including files outside the review diff. Unchanged assets need not be reread in JS.
    hash.update(workingBinary);
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
    const index = createHash('sha256').update(cachedBinary).digest('hex');
    let diff = baseDiff;
    if (/^Binary files .* differ$/m.test(diff)) throw new Error('Binary changes need manual review.');
    let size = Buffer.byteLength(diff);
    for (const file of added.sort()) {
      const content = await readFile(join(this.root, file), 'utf8');
      if (content.includes('\0')) throw new Error('Binary new files need manual review.');
      const entry = `\nNew file ${JSON.stringify(file)}:\n${content}\n`;
      size += Buffer.byteLength(entry);
      if (size <= MAX_REVIEW_BYTES) diff += entry; // past the limit the embedded diff is discarded, so stop building it
    }
    const oversized = size > MAX_REVIEW_BYTES;
    return { fingerprint: hash.digest('hex'), files, diff: oversized ? undefined : diff, oversized, index };
  }
}
