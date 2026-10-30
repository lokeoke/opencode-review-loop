import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Shared by the live smoke and benchmark: both drive the existing authenticated local
// OpenCode service and refuse to continue if that service is replaced mid-run.
export async function connectLive() {
  const registrationPath = process.env.OPENCODE_TEST_SERVICE_FILE || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'opencode/service.json');
  const endpoint = JSON.parse(await readFile(registrationPath, 'utf8'));
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint.url).hostname) || !endpoint.password) throw new Error('Live run needs an authenticated local existing service.');
  async function api(method, path, body) {
    const current = JSON.parse(await readFile(registrationPath, 'utf8'));
    if (current.id !== endpoint.id || current.pid !== endpoint.pid) throw new Error('Service identity changed; refusing automatic continuation.');
    const response = await fetch(new URL(path, endpoint.url), {
      method: method.toUpperCase(),
      headers: { authorization: `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString('base64')}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`OpenCode ${method} ${path} failed with HTTP ${response.status}.`);
    const raw = await response.text();
    if (!raw.trim()) return undefined;
    const result = JSON.parse(raw);
    return result.data ?? result;
  }
  const command = async (sessionID, text) => (await api('post', '/api/rpc/review-loop/command', { input: { sessionID, text } })).output;
  return { api, command };
}

// Polls the run state until it is terminal. Returns undefined at the deadline;
// throws the controller's synthetic error if the run never produced state.
export async function waitForTerminal({ api, store, worktree, sessionID, deadline, onPhase = () => {} }) {
  let lastPhase;
  while (Date.now() < deadline) {
    await delay(2000);
    // Fails fast if the service died or was replaced; otherwise frozen run state would wait out the deadline.
    await api('get', `/api/session/${sessionID}`);
    const state = await store.read(worktree);
    if (state && ['passed', 'stopped'].includes(state.phase)) return state;
    if (state) {
      const phase = `${state.phase}, round ${state.round}`;
      if (phase !== lastPhase) onPhase(phase);
      lastPhase = phase;
      continue;
    }
    const messages = await api('get', `/api/session/${sessionID}/context`);
    const error = messages.findLast((message) => message.type === 'synthetic' && message.text.startsWith('Review loop:'));
    if (error) throw new Error(error.text);
  }
  return undefined;
}
