import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';

export const CHECK_TIMEOUT_MS = 5 * 60_000;
const KILL_GRACE_MS = 1000;
const SHELL_PATH_TIMEOUT_MS = 10_000;
const SHELL_OUTPUT_LIMIT = 64 * 1024;
const PATH_MARKER = '__REVIEW_LOOP_PATH__';
const COMMAND_NOT_FOUND = 127;

// OpenCode Desktop starts the service with launchd's minimal PATH, so tools the user installed
// (node, npm, Homebrew) are missing from checks. Ask the user's own interactive login shell, the way a
// terminal would see it. `env -0` prints PATH colon-separated in every shell, fish included, with entries
// NUL-separated so a multi-line value cannot pose as PATH; output before the marker is profile noise.
// Resolves undefined when the shell gives no PATH.
function readShellPath({ shell = process.env.SHELL || userInfo().shell || '/bin/sh', timeoutMs = SHELL_PATH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let output = '', done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const environment = output.slice(output.indexOf(PATH_MARKER) + PATH_MARKER.length).trimStart().split('\0');
      resolve(output.includes(PATH_MARKER) ? environment.find((entry) => entry.startsWith('PATH='))?.slice('PATH='.length) || undefined : undefined);
    };
    let child;
    try { child = spawn(shell, ['-ilc', `echo ${PATH_MARKER}; /usr/bin/env -0`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { resolve(undefined); return; }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      finish();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (output.length < SHELL_OUTPUT_LIMIT) output += chunk; });
    child.once('error', finish);
    child.once('close', finish);
  });
}

// The login shell PATH comes first; the service entries stay after it.
const mergePath = (shellPath, fallback) => (shellPath ? [...new Set([...shellPath.split(':'), ...fallback.split(':')].filter(Boolean))].join(':') : fallback);

export async function resolveShellPath({ fallback = process.env.PATH ?? '', ...options } = {}) {
  return mergePath(await readShellPath(options), fallback);
}

// Cached for the service lifetime once the shell answered. A failed lookup is retried after a cooldown,
// so a shell that never answers costs one timeout per cooldown rather than one per check.
export const SHELL_RETRY_MS = 5 * 60_000;
let shellPath, failedAt;
export function checkPath(now = Date.now()) {
  if (failedAt !== undefined && now - failedAt < SHELL_RETRY_MS) return Promise.resolve(process.env.PATH ?? '');
  shellPath ??= readShellPath().then((path) => {
    failedAt = path ? undefined : now;
    if (!path) shellPath = undefined;
    return mergePath(path, process.env.PATH ?? '');
  });
  return shellPath;
}

export function runCheck(command, cwd, { signal, timeoutMs = CHECK_TIMEOUT_MS, path = process.env.PATH } = {}) {
  if (process.platform === 'win32') throw new Error('Checks currently require a POSIX host (macOS or Linux).');
  if (typeof command !== 'string' || !command.trim()) throw new Error('Empty check command.');
  if (signal?.aborted) return Promise.reject(new Error('Check cancelled.'));
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: 'ignore', env: { ...process.env, PATH: path } });
    let failure, killTimer;
    const kill = (kind) => {
      if (!Number.isInteger(child.pid)) return;
      try { process.kill(-child.pid, kind); }
      catch (error) {
        if (error.code !== 'ESRCH') {
          failure = `Process cleanup unconfirmed: ${error.message}`;
          reject(Object.assign(new Error(failure), { cleanupUnconfirmed: true, pid: child.pid }));
        }
      }
    };
    const stop = (reason) => {
      if (failure) return;
      failure = reason;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
    };
    const abort = () => stop('Check cancelled.');
    const timer = setTimeout(() => stop('Check timed out.'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', (error) => { cleanup(); clearTimeout(killTimer); reject(error); });
    child.once('exit', (code, exitSignal) => {
      cleanup();
      // Kill descendants that survived the shell, including background jobs.
      kill('SIGKILL');
      clearTimeout(killTimer);
      const hint = code === COMMAND_NOT_FOUND ? ` (command not found with PATH=${path})` : '';
      if (failure || code !== 0) reject(Object.assign(new Error(failure || `Check failed with exit ${code ?? exitSignal}${hint}: ${command}`), { command, exitCode: code, exitSignal, durationMs: Date.now() - started }));
      else resolve({ command, exitCode: 0, durationMs: Date.now() - started });
    });
  });
}
