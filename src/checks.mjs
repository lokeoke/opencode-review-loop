import { spawn } from 'node:child_process';

export const CHECK_TIMEOUT_MS = 5 * 60_000;
const KILL_GRACE_MS = 1000;

export function runCheck(command, cwd, { signal, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  if (process.platform === 'win32') throw new Error('Checks currently require a POSIX host (macOS or Linux).');
  if (typeof command !== 'string' || !command.trim()) throw new Error('Empty check command.');
  if (signal?.aborted) return Promise.reject(new Error('Check cancelled.'));
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: 'ignore' });
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
      if (failure || code !== 0) reject(Object.assign(new Error(failure || `Check failed with exit ${code ?? exitSignal}: ${command}`), { command, exitCode: code, exitSignal, durationMs: Date.now() - started }));
      else resolve({ command, exitCode: 0, durationMs: Date.now() - started });
    });
  });
}
