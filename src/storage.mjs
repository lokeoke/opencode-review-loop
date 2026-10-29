import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_STATE = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'opencode-review-loop');

export class RunStore {
  constructor(directory = DEFAULT_STATE) { this.directory = directory; }
  key(worktree) { return createHash('sha256').update(worktree).digest('hex'); }
  async read(worktree) {
    try { return JSON.parse(await readFile(join(this.directory, `${this.key(worktree)}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  async acquire(worktree, id) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const key = this.key(worktree);
    const lock = join(this.directory, `${key}.lock`);
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('An active or interrupted run owns this worktree. Inspect status; do not remove a live lock.');
      throw error;
    }
    const nonce = randomUUID();
    try { await writeFile(join(lock, 'owner.json'), JSON.stringify({ id, nonce, pid: process.pid, worktree }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
    let released = false;
    return {
      save: async (state) => {
        if (released) throw new Error('Run lease has been released.');
        const path = join(this.directory, `${key}.json`);
        const temporary = `${path}.${nonce}.tmp`;
        await writeFile(temporary, JSON.stringify({ version: 1, ...state, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
        await rename(temporary, path);
      },
      release: async () => {
        if (released) return;
        const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
        if (owner.nonce !== nonce) throw new Error('Worktree lease ownership changed.');
        released = true;
        await rm(lock, { recursive: true });
      },
    };
  }
}
