import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RunStore } from '../src/storage.mjs';

async function smokeWithReviewer(t, tools, { candidateLoaded = true, failStart = false } = {}) {
  const commands = [];
  const root = await mkdtemp(join(tmpdir(), 'review-loop-smoke-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let directory;
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      let data;
      if (req.url === '/api/session' && req.method === 'POST') {
        directory = body.location.directory;
        data = { id: 'fixer' };
      } else if (req.url === '/api/rpc/review-loop/command') {
        commands.push(body.input.text);
        if (body.input.text === 'start') {
          data = { output: { text: candidateLoaded ? 'New user input in the owning session stops the review loop. Use /review-loop status to follow it or /review-loop stop to cancel.' : 'No checks found.' } };
        } else if (body.input.text.startsWith('start')) {
          if (failStart) throw new Error('Response lost after the run started.');
          await writeFile(join(directory, 'access.mjs'), 'export function canDelete(userId, ownerId) { return !!userId && userId === ownerId; }\n');
          const store = new RunStore(join(root, 'opencode-review-loop'));
          const lease = await store.acquire(await realpath(directory), 'test-run');
          await lease.save({ id: 'test-run', phase: 'passed', round: 2, reviewerID: 'reviewer' });
          await lease.release();
          data = { output: { text: 'Started' } };
        } else data = { output: { text: 'Stopped' } };
      } else if (req.url === '/api/session/fixer') data = { model: { id: 'gpt-6.1-sol' } };
      else if (req.url === '/api/session/reviewer/context') data = [{ type: 'assistant', content: tools.map((name) => ({ type: 'tool', name, state: { status: 'completed' } })) }];
      else throw new Error(`Unexpected request: ${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const registration = join(root, 'service.json');
  await writeFile(registration, JSON.stringify({ id: 'test', pid: process.pid, url: `http://127.0.0.1:${server.address().port}`, password: 'test' }));
  const child = spawn(process.execPath, ['scripts/smoke.mjs', '--live'], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: root, OPENCODE_TEST_TMP: root, OPENCODE_TEST_SERVICE_FILE: registration } });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { code, output, commands };
}

test('live smoke reports inconclusive when the reviewer never used the source tool', async (t) => {
  const result = await smokeWithReviewer(t, ['review_loop_submit_review']);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /inconclusive.*review_loop_source/i);
});

test('live smoke accepts a review only after source access and submission succeeded', async (t) => {
  const result = await smokeWithReviewer(t, ['review_loop_source', 'review_loop_submit_review']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /source.*submission.*verified/i);
});

test('live smoke refuses to run when the candidate preview is not loaded', async (t) => {
  const result = await smokeWithReviewer(t, ['review_loop_source', 'review_loop_submit_review'], { candidateLoaded: false });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /candidate.*not loaded/i);
});

test('live smoke cancels the run when the start request fails after it was sent', async (t) => {
  const result = await smokeWithReviewer(t, ['review_loop_source', 'review_loop_submit_review'], { failStart: true });
  assert.notEqual(result.code, 0);
  assert.equal(result.commands.at(-1), 'stop');
});
