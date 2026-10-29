import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Engine } from '../src/engine.mjs';

export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-review-loop-engine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
  git('init', '-b', 'main');
  await writeFile(join(directory, 'app.js'), 'export const value = 1;\n');
  await writeFile(join(directory, 'helper.js'), 'export function read(value) { return value.id; }\n');
  git('add', 'app.js', 'helper.js');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial');
  await writeFile(join(directory, 'app.js'), 'export const value = 2;\n');
  const sessions = new Map([['fixer', { id: 'fixer', agent: 'build', model: { providerID: 'github-copilot', id: 'gpt-6.1-sol' }, location: { directory }, outcome: 'succeeded' }]]);
  const messages = new Map();
  const reports = [];
  let onPrompt = async () => {};
  const ctx = {
    model: { list: async () => ({ location: { directory }, data: [{ id: 'claude-sonnet-5.5', providerID: 'github-copilot', enabled: true, capabilities: { tools: true } }] }) },
    session: {
      get: async ({ sessionID }) => sessions.get(sessionID),
      create: async (input) => { const session = { ...input, id: 'reviewer', location: { directory }, outcome: 'succeeded' }; sessions.set(session.id, session); return session; },
      prompt: async (input) => { await onPrompt(input); return { id: 'prompt-1' }; },
      wait: async () => {},
      context: async ({ sessionID }) => messages.get(sessionID) ?? [],
      synthetic: async ({ text, resume }) => { assert.equal(resume, false, 'Status messages must never schedule model turns'); reports.push(text); },
      interrupt: async () => ({ interrupted: true }),
    },
  };
  const engine = new Engine(ctx, { stateDirectory: join(directory, '.git/review-loop-state') });
  t.after(() => engine.dispose());
  return { directory, engine, ctx, reports, sessions, messages, setPrompt: (fn) => { onPrompt = fn; } };
}

