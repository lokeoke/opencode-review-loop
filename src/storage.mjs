import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_STATE = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'opencode-review-loop');

export class RunStore {
  constructor(directory = DEFAULT_STATE) { this.directory = directory; }
  key(worktree) { return createHash('sha256').update(worktree).digest('hex'); }
  async read(worktree, id) {
    if (id !== undefined && !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid run ID.');
    try { return JSON.parse(await readFile(join(this.directory, `${this.key(worktree)}${id ? `.${id}` : ''}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  async acquire(worktree, id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid run ID.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const key = this.key(worktree);
    const lock = join(this.directory, `${key}.lock`);
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('An active or interrupted run owns this worktree. Inspect status; use the explicit recovery script only after verifying all old processes stopped.');
      throw error;
    }
    const nonce = randomUUID();
    try { await writeFile(join(lock, 'owner.json'), JSON.stringify({ id, nonce, pid: process.pid, hostname: hostname(), worktree }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
    let released = false, releasePromise, writes = Promise.resolve();
    const atomic = async (path, content) => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    };
    return {
      save: (state) => {
        if (released) throw new Error('Run lease has been released.');
        const content = JSON.stringify({ version: 1, ...state, updatedAt: new Date().toISOString() }, null, 2);
        const write = writes.then(async () => {
          await atomic(join(this.directory, `${key}.${id}.json`), content);
          await atomic(join(this.directory, `${key}.json`), content);
        });
        writes = write.catch(() => {}); // The caller receives the rejection; later terminal-state writes may still succeed.
        return write;
      },
      release: () => {
        if (releasePromise) return releasePromise;
        released = true;
        releasePromise = (async () => {
          await writes;
          const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
          if (owner.nonce !== nonce) throw new Error('Worktree lease ownership changed.');
          await rm(lock, { recursive: true });
        })();
        return releasePromise;
      },
    };
  }

  async recover(worktree, id, { processesStopped = false } = {}) {
    if (!processesStopped) throw new Error('Explicit confirmation that all old run/check processes stopped is required.');
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid run ID.');
    const key = this.key(worktree), lock = join(this.directory, `${key}.lock`);
    const recovery = `${lock}.recovery`;
    await mkdir(recovery, { mode: 0o700 });
    try {
      const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
      if (owner.id !== id || owner.worktree !== worktree || (owner.hostname && owner.hostname !== hostname())) throw new Error('Lock identity does not match this local run.');
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Cannot establish lock-owner identity.');
      try { process.kill(owner.pid, 0); throw new Error('Lock owner is still alive; recovery refused.'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      const current = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
      if (current.nonce !== owner.nonce) throw new Error('Lock ownership changed during recovery.');
      const state = await this.read(worktree, id) ?? await this.read(worktree);
      if (state?.id === id) {
        const stopped = JSON.stringify({ ...state, phase: 'stopped', reason: 'Explicit stale-run recovery; no execution resumed.' }, null, 2);
        for (const suffix of [`.${id}`, '']) {
          const target = join(this.directory, `${key}${suffix}.json`), temporary = `${target}.${randomUUID()}.tmp`;
          await writeFile(temporary, stopped, { mode: 0o600, flag: 'wx' });
          await rename(temporary, target);
        }
      }
      const archive = `${lock}.recovered-${randomUUID()}`;
      await rename(lock, archive);
      return archive;
    } finally { await rm(recovery, { recursive: true }); }
  }
}
