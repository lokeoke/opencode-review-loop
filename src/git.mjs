import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isCheckControlPath } from './check-policy.mjs';

const exec = promisify(execFile);
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_REVIEW_BYTES = 192 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_RESPONSE_BYTES = 32 * 1024;
const MAX_REVIEW_FILES = 300;
const MAX_DIFF_LINE_CHARS = 4000;
const GIT_SYMLINK_MODE = '120000';
const SOURCE_SIZE_REASON = `Source exceeds the ${MAX_SOURCE_FILE_BYTES / (1024 * 1024)} MiB per-file size limit; inspect its diff instead.`;
export const END_OF_DIFF = '(end of diff)';
export const SOURCE_UNAVAILABLE = '[Unavailable: ';
const unavailable = (reason) => `${SOURCE_UNAVAILABLE}${reason}]`;
const metadataPath = (file) => /(^|\/)\.git($|\/)/i.test(file);
export const sensitivePath = (file) => /(^|\/)(\.env($|\.)|\.git($|\/)|id_(rsa|ed25519)$)|\.(pem|key|p12|pfx)$/i.test(file);
class InspectionBoundaryError extends Error {}

async function git(cwd, args, encoding = 'utf8') {
  try {
    const { stdout } = await exec('git', [...(args[0] === 'diff' ? ['--literal-pathspecs'] : []), '-c', 'core.fsmonitor=false', ...args], { cwd, encoding, maxBuffer: MAX_GIT_OUTPUT, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
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

function renderDiff(bytes) {
  if (isUtf8(bytes)) return bytes.toString('utf8');
  const lines = [];
  for (let start = 0; start <= bytes.length;) {
    const newline = bytes.indexOf(10, start), end = newline < 0 ? bytes.length : newline;
    const line = bytes.subarray(start, end);
    lines.push(isUtf8(line) ? line.toString('utf8') : `Non-UTF-8 diff line (hex bytes): ${line.toString('hex')}`);
    if (newline < 0) break;
    start = end + 1;
  }
  return lines.join('\n');
}

// Read one extra byte to detect growth past the limit without buffering an unbounded file.
async function readNewFile(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min((await handle.stat()).size, MAX_SOURCE_FILE_BYTES) + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
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
    // Freeze disclosure provenance: staging a previously withheld file later cannot grant source access.
    const [indexEntries, ...treeEntries] = (await Promise.all([
      git(root, ['ls-files', '--stage', '-z']),
      git(root, ['ls-tree', '-r', '-z', head]),
      baseSha === head ? '' : git(root, ['ls-tree', '-r', '-z', baseSha]),
    ])).map(paths);
    const entryPath = (entry) => entry.slice(entry.indexOf('\t') + 1);
    const indexedAtOpen = new Set(indexEntries.map(entryPath));
    const entries = [...indexEntries, ...treeEntries.flat()].map((entry) => ({ mode: entry.slice(0, entry.indexOf(' ')), path: entryPath(entry) }));
    const trackedAtOpen = new Set(entries.map((entry) => entry.path));
    const symlinkPaths = new Set(entries.filter((entry) => entry.mode === GIT_SYMLINK_MODE).map((entry) => entry.path));
    // Keep the directory exactly as OpenCode reports it: resource paths are relative to it, not to its canonical form.
    return new GitScope({ root, cwd, sessionDirectory: resolve(directory), baseSha, head, branch, trackedAtOpen, indexedAtOpen, symlinkPaths });
  }

  constructor(info) { Object.assign(this, info); this.diffCache = new Map(); this.omissions = new Map(); }

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
    const components = file.split('/');
    if (components.some((_, index) => this.symlinkPaths.has(components.slice(0, index + 1).join('/')))) return 'symlink entry in the review scope, including a deleted or replaced link';
    if (isCheckControlPath(file)) return 'protected check/launch control file';
    if (/(^|\/)(AGENTS\.md|CLAUDE\.md|\.opencode|\.claude|\.cursor|\.agents|node_modules|\.gitignore|\.gitattributes)($|\/)/i.test(file)) return 'protected agent/runtime configuration or dependency path';
    try { await git(this.root, ['check-ignore', '--quiet', '--', file]); return 'ignored by Git'; }
    catch (error) { return error.code === 1 ? undefined : `Git could not classify the path (exit ${error.code})`; }
  }

  async canEdit(path) { return (await this.editDenial(path)) === undefined; }

  disclosureAllowed(file) { return !metadataPath(file) && (!sensitivePath(file) || this.trackedAtOpen.has(file)); }

  // Inspection may read a leaf link's metadata, never traverse a link in its ancestors.
  async inspectionStat(file) {
    const candidate = resolve(this.root, file), rel = relative(this.root, candidate);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || metadataPath(rel)) throw new InspectionBoundaryError('Source path escapes the worktree or accesses Git metadata.');
    let existing = this.root;
    const components = rel.split(sep);
    for (const [index, component] of components.entries()) {
      existing = join(existing, component);
      let stat;
      try { stat = await lstat(existing); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined; throw error; }
      if (index === components.length - 1) return stat;
      if (stat.isSymbolicLink()) throw new InspectionBoundaryError('Source path traverses a symlink ancestor.');
    }
  }

  async inspectEntry(file) {
    const reason = this.omissions.get(file) ?? (!this.disclosureAllowed(file) ? 'Sensitive-looking content was not tracked when this scope was opened.' : undefined);
    if (reason) return { reason };
    try {
      const stat = await this.inspectionStat(file);
      // Historical membership permits deletion diffs, not disclosure of an untracked replacement.
      if (stat && sensitivePath(file) && !this.indexedAtOpen.has(file)) return { reason: 'Sensitive-looking working-tree content was not tracked when this scope was opened.' };
      return { stat };
    }
    catch (error) { if (error instanceof InspectionBoundaryError) return { reason: error.message }; throw error; }
  }

  async readInspection(file) {
    const { stat, reason } = await this.inspectEntry(file);
    if (reason) return { reason };
    if (!stat) return { reason: 'Deleted source; inspect its diff instead.' };
    if (stat.isSymbolicLink()) {
      this.symlinkPaths.add(file);
      const target = await readlink(join(this.root, file), { encoding: 'buffer' });
      return { content: isUtf8(target) ? `Symlink target (JSON): ${JSON.stringify(target.toString('utf8'))}` : `Symlink target (hex bytes): ${target.toString('hex')}`, size: target.length };
    }
    if (!stat.isFile()) return { reason: 'Source is a non-file/submodule.' };
    if (stat.size > MAX_SOURCE_FILE_BYTES) return { reason: SOURCE_SIZE_REASON };
    const bytes = await readNewFile(join(this.root, file));
    if (bytes.length > MAX_SOURCE_FILE_BYTES) return { reason: SOURCE_SIZE_REASON };
    if (bytes.includes(0) || !isUtf8(bytes)) return { reason: 'Binary or non-UTF-8 source is unavailable.' };
    return { content: bytes.toString('utf8'), size: bytes.length };
  }

  async source({ operation, path = '', query = '', offset = 1, limit = 150 }) {
    if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid source pagination.');
    const files = [...new Set(paths(await git(this.root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])))].filter((file) => !metadataPath(file)).sort();
    if (operation === 'list') return files.slice(offset - 1, offset - 1 + limit).join('\n') + `\n(${files.length} source paths total; paginate with offset/limit)`;
    if (!['read', 'search'].includes(operation)) throw new Error('Use list, read, or search.');
    if (operation === 'read' && (!files.includes(path) || path.includes('\\'))) throw new Error('Path is not an allowed source file.');
    if (operation === 'search' && (typeof query !== 'string' || !query || query.length > 200)) throw new Error('Provide a literal search query of 1–200 characters.');
    const output = [];
    let matches = 0, bytes = 0, scanned = 0;
    for (const file of operation === 'read' ? [path] : files) {
      const inspected = await this.readInspection(file);
      if (inspected.reason) {
        if (operation === 'read') return unavailable(inspected.reason);
        continue;
      }
      scanned += inspected.size;
      if (scanned > MAX_SOURCE_BYTES) throw new Error('Search exceeded source budget.');
      const lines = inspected.content.split('\n');
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

  async reviewDiff(file, added) {
    const { stat, reason } = await this.inspectEntry(file);
    if (reason) return { reason };
    if (stat && !stat.isFile() && !stat.isSymbolicLink()) return { reason: 'Non-file/submodule content is not inspected.' };
    if (added.includes(file)) {
      const inspected = await this.readInspection(file);
      return inspected.reason ? inspected : { text: `New file ${JSON.stringify(file)}:\n${inspected.content}` };
    }
    const bytes = await git(this.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', this.baseSha, '--', file], 'buffer');
    if (bytes.includes(0)) return { reason: 'Binary content is not inspected.' };
    const text = renderDiff(bytes);
    if (/^Binary files .* differ$/m.test(text)) return { reason: 'Binary content is not inspected.' };
    if (/^(?:new file mode|deleted file mode|old mode|new mode) 160000$|^index [\da-f]+\.\.[\da-f]+ 160000$/m.test(text)) return { reason: 'Submodule content is not inspected; only the repository Git entry is fingerprinted.' };
    return { text };
  }

  // One changed file's diff, paged by diff line, for changes too large to embed. `complete` means the end was returned.
  async fileDiff({ path, offset = 1, limit = 150 }) {
    if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid diff pagination.');
    const { added, files } = this.pathsCache ??= await this.changedPaths();
    if (typeof path !== 'string' || !files.includes(path)) throw new Error('Path is not a changed file in this review.');
    let lines = this.diffCache.get(path);
    if (!lines) {
      const inspected = await this.reviewDiff(path, added);
      if (inspected.reason) {
        this.omissions.set(path, inspected.reason);
        return { complete: false, next: offset, unavailable: true, text: unavailable(inspected.reason) };
      }
      lines = splitDiffLines(inspected.text);
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
    this.omissions.clear();
    const { added, files } = await this.changedPaths();
    this.pathsCache = { added, files };
    const [workingBinary, cachedBinary] = await Promise.all([
      git(this.root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--'], 'buffer'),
      git(this.root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--'], 'buffer'),
    ]);
    const hash = createHash('sha256').update(`${head}\0${branch}\0`);
    // HEAD is pinned: Git's binary working diff identifies all tracked changes,
    // including files outside the review diff. Unchanged assets need not be reread in JS.
    hash.update(workingBinary);
    let bytes = 0;
    for (const file of added.sort()) {
      hash.update(file).update('\0');
      try {
        const stat = await this.inspectionStat(file);
        if (!stat) { hash.update('deleted'); continue; }
        hash.update(String(stat.mode));
        if (stat.isSymbolicLink()) {
          this.symlinkPaths.add(file);
          const target = await readlink(join(this.root, file), { encoding: 'buffer' });
          bytes += target.length;
          if (bytes > MAX_SOURCE_BYTES) throw new Error('Source exceeds the supported fingerprint budget.');
          hash.update(target);
        } else if (stat.isFile()) {
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
    let diff = '', size = 0, inspectedFiles = 0;
    for (const file of files) {
      const inspected = inspectedFiles >= MAX_REVIEW_FILES && this.disclosureAllowed(file) ? { reason: `Outside the ${MAX_REVIEW_FILES}-file inspection budget.` } : await this.reviewDiff(file, added);
      if (inspected.reason) { this.omissions.set(file, inspected.reason); continue; }
      inspectedFiles += 1;
      const entry = `${inspected.text}\n`;
      size += Buffer.byteLength(entry);
      if (size <= MAX_REVIEW_BYTES) diff += entry; // past the limit the embedded diff is discarded, so stop building it
    }
    const oversized = size > MAX_REVIEW_BYTES;
    return { fingerprint: hash.digest('hex'), files, diff: oversized ? undefined : diff, oversized, index, omissions: [...this.omissions].map(([path, reason]) => ({ path, reason })) };
  }
}
