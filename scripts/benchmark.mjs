import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { INPUT_WARNING } from '../src/command.mjs';
import { RunStore } from '../src/storage.mjs';
import { extractFindings, loadFixtures, materialize, score } from './bench-score.mjs';
import { connectLive, waitForTerminal } from './live.mjs';

const USAGE = `Usage: node scripts/benchmark.mjs --live [--runner plugin|claude|both] [--runs 3] [--only a,b]
  [--fixer github-copilot-model-id] [--reviewer github-copilot/MODEL] [--claude-model MODEL] [--claude-prompt TEXT]
Spends Copilot and Claude usage. Fixtures are built in disposable directories and retained for inspection.`;
const REPOSITORY = new URL('..', import.meta.url).pathname;
const RESULTS = join(REPOSITORY, 'bench/results');
const RUN_DEADLINE_MS = 46 * 60_000;
const CLAUDE_TIMEOUT_MS = 20 * 60_000;
const BLOCKING = new Set(['blocker', 'major']);
const DEFAULT_CLAUDE_PROMPT = 'Review these code changes for correctness, security, regression and test-quality defects. Report only concrete defects with a failure scenario.';
const CLAUDE_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git show:*)'];

function parseArgs(argv) {
  const options = { runner: 'both', runs: 3, fixer: 'gpt-6.1-sol', claudePrompt: DEFAULT_CLAUDE_PROMPT };
  if (!argv.includes('--live')) throw new Error(USAGE);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--live') continue;
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${key}.\n${USAGE}`);
    if (key === '--runner' && ['plugin', 'claude', 'both'].includes(value)) options.runner = value;
    else if (key === '--runs' && Number.isSafeInteger(Number(value)) && Number(value) > 0) options.runs = Number(value);
    else if (key === '--only') options.only = value.split(',');
    else if (key === '--fixer') options.fixer = value;
    else if (key === '--reviewer') options.reviewer = value;
    else if (key === '--claude-model') options.claudeModel = value;
    else if (key === '--claude-prompt') options.claudePrompt = value;
    else throw new Error(`Invalid option ${key} ${value}.\n${USAGE}`);
  }
  return options;
}

const scope = (fixture) => (fixture.git ? `the changes between ${fixture.git.base} and the working tree (git diff ${fixture.git.base})` : 'the uncommitted changes against HEAD (git diff HEAD, plus untracked files)');

async function runPlugin(live, fixture, directory, options) {
  const session = await live.api('post', '/api/session', { title: `Review-loop benchmark: ${fixture.name}`, agent: 'build', model: { providerID: 'github-copilot', id: options.fixer }, location: { directory } });
  const args = [fixture.git && `--base ${fixture.git.base}`, options.reviewer && `--reviewer ${options.reviewer}`].filter(Boolean).join(' ');
  const preview = await live.command(session.id, `start ${args}`);
  if (!preview.text.includes(INPUT_WARNING)) throw new Error(`Candidate warning not loaded in the service; refusing to run. Preview: ${preview.text}`);
  const response = await live.command(session.id, `start ${args} --check ${JSON.stringify(fixture.check)}`);
  if (response.text.startsWith('Review loop:')) throw new Error(response.text);
  const worktree = await realpath(directory);
  const state = await waitForTerminal({ ...live, store: new RunStore(), worktree, sessionID: session.id, deadline: Date.now() + RUN_DEADLINE_MS, onPhase: (phase) => console.log(`  ${phase}`) });
  if (!state) {
    await live.command(session.id, 'stop').catch(() => console.error('  Unable to confirm cancellation; inspect retained run state.'));
    return { outcome: 'timeout', findings: [], fixerSession: session.id };
  }
  const review = state.history?.[0]?.review ?? state.submission;
  return {
    outcome: state.phase,
    reason: state.reason,
    rounds: state.round,
    complete: review?.complete,
    findings: review?.issues ?? [],
    fixRan: Boolean(review?.issues?.some((issue) => BLOCKING.has(issue.severity))),
    reviewer: state.reviewerModel,
    reviewerSession: state.reviewerID,
    fixerSession: session.id,
  };
}

async function runClaude(fixture, directory, options) {
  const prompt = `${options.claudePrompt}\n\nReview scope: ${scope(fixture)}. Do not edit files. End your answer with a JSON array in a \`\`\`json block: [{"file": "path relative to the repository root", "line": 1, "severity": "blocker|major|minor", "problem": "..."}]. Use [] when you find nothing.`;
  const args = ['-p', prompt, '--output-format', 'json', '--allowedTools', ...CLAUDE_TOOLS, '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', ...(options.claudeModel ? ['--model', options.claudeModel] : [])];
  const { stdout } = await promisify(execFile)('claude', args, { cwd: directory, timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  const output = JSON.parse(stdout);
  const findings = extractFindings(output.result);
  return { outcome: output.is_error ? 'error' : findings ? 'reviewed' : 'unparsed', findings: findings ?? [], costUsd: output.total_cost_usd, turns: output.num_turns, claudeSession: output.session_id };
}

function summarize(fixtures, runs) {
  const lines = ['| Fixture | Runner | Seeded defects caught (per defect, of runs) | Unmatched findings (avg) | Fix pass on clean | Outcomes | Avg minutes |', '|---|---|---|---|---|---|---|'];
  for (const fixture of fixtures) {
    for (const runner of [...new Set(runs.map((run) => run.runner))]) {
      const own = runs.filter((run) => run.fixture === fixture.name && run.runner === runner);
      if (!own.length) continue;
      const caught = fixture.defects.map((defect) => `${defect.id} ${own.filter((run) => run.score.caught.includes(defect.id)).length}/${own.length}`).join(', ') || 'clean';
      const unmatched = (own.reduce((sum, run) => sum + run.score.unmatched.length, 0) / own.length).toFixed(1);
      const fixes = fixture.defects.length ? '-' : `${own.filter((run) => run.fixRan).length}/${own.length}`;
      const outcomes = own.map((run) => run.outcome).join(', ');
      const minutes = (own.reduce((sum, run) => sum + run.durationMs, 0) / own.length / 60_000).toFixed(1);
      lines.push(`| ${fixture.name} | ${runner} | ${caught} | ${unmatched} | ${fixes} | ${outcomes} | ${minutes} |`);
    }
  }
  return `${lines.join('\n')}\n\nUnmatched findings need manual assessment: they may be real defects, false findings or a matched defect at an unexpected line.\n`;
}

const options = parseArgs(process.argv.slice(2));
const fixtures = (await loadFixtures()).filter((fixture) => !options.only || options.only.includes(fixture.name));
const runners = options.runner === 'both' ? ['plugin', 'claude'] : [options.runner];
const live = runners.includes('plugin') ? await connectLive() : undefined;
const startedAt = new Date().toISOString();
const runs = [];
for (const fixture of fixtures) {
  for (const runner of runners) {
    for (let run = 1; run <= options.runs; run++) {
      const directory = await mkdtemp(join(tmpdir(), `review-loop-bench-${fixture.name}-`));
      await materialize(fixture, directory, REPOSITORY);
      console.log(`${fixture.name} ${runner} #${run}: ${directory}`);
      const started = Date.now();
      let result;
      try {
        result = runner === 'plugin' ? await runPlugin(live, fixture, directory, options) : await runClaude(fixture, directory, options);
      } catch (error) {
        result = { outcome: 'error', error: error.message, findings: [] };
      }
      const record = { fixture: fixture.name, runner, run, directory, durationMs: Date.now() - started, ...result, score: score(fixture, result.findings) };
      console.log(`  ${record.outcome}: caught [${record.score.caught}] missed [${record.score.missed}] unmatched ${record.score.unmatched.length}${record.error ? ` (${record.error})` : ''}`);
      runs.push(record);
    }
  }
}
await mkdir(RESULTS, { recursive: true });
const stem = join(RESULTS, startedAt.replace(/[:.]/g, '-'));
await writeFile(`${stem}.json`, `${JSON.stringify({ startedAt, options, runs }, null, 2)}\n`);
await writeFile(`${stem}.md`, `# Benchmark ${startedAt}\n\nOptions: ${JSON.stringify(options)}\n\n${summarize(fixtures, runs)}`);
console.log(`Results: ${stem}.json and ${stem}.md`);
