import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { Run } from './controller.mjs';
import { GitScope } from './git.mjs';
import { RunStore } from './storage.mjs';
import { selectReviewer } from './options.mjs';
import { runCheck } from './checks.mjs';
import { fixPrompt, reviewPrompt } from './prompts.mjs';
import { checkPolicyFingerprint } from './check-policy.mjs';
import { validateReview } from './contracts.mjs';
import { DENIAL_PREFIX } from './security.mjs';
import { scopeKind } from './scope.mjs';

export const PHASE_TIMEOUT_MS = 10 * 60_000;
export const RUN_TIMEOUT_MS = 45 * 60_000;
const CONTROL_TIMEOUT_MS = 15_000;
export const MAX_PROGRESS_EVENTS = 64;
const MAX_PROGRESS_TEXT = 8192;
const MAX_DENIALS = 32;
// Locations load separate plugin instances; session guards must follow a moved session.
const ACTIVE_RUNS = Symbol.for('opencode-review-loop.active.v1');
globalThis[ACTIVE_RUNS] ??= new Map();

function sameModel(a, b) { return a?.providerID === b?.providerID && a?.id === b?.id && (a?.variant ?? 'default') === (b?.variant ?? 'default'); }

export class Engine {
  constructor(ctx, { stateDirectory } = {}) {
    this.ctx = ctx;
    this.store = new RunStore(stateDirectory);
    this.active = globalThis[ACTIVE_RUNS];
    this.disposed = false;
  }

  activeFor(sessionID) {
    return [...this.active.values()].find((item) => item.fixerID === sessionID || item.reviewerID === sessionID);
  }

  async progress(active, text) {
    if (text.length > MAX_PROGRESS_TEXT) text = text.slice(0, MAX_PROGRESS_TEXT) + '\n[Truncated; use status for full findings.]';
    active.run.state.progress ??= [];
    active.run.state.progress.push({ time: new Date().toISOString(), text });
    if (active.run.state.progress.length > MAX_PROGRESS_EVENTS) {
      active.run.state.progress.shift();
      active.run.state.progressDropped = (active.run.state.progressDropped ?? 0) + 1;
    }
    await active.lease.save(active.run.state);
    try { await this.report?.(active.fixerID, text); }
    catch (error) { console.error(`[review-loop] Progress delivery failed: ${error.message}`); }
  }

  recordDenial(active, action, resources, reasons) {
    const denials = (active.run.state.denials ??= []);
    denials.push({ time: new Date().toISOString(), action, resources: resources.slice(0, 8), reasons });
    if (denials.length > MAX_DENIALS) denials.shift();
  }

  async status(sessionID) {
    const active = this.activeFor(sessionID);
    if (active) return structuredClone(active.run.state);
    const session = await this.ctx.session.get({ sessionID });
    const scope = await GitScope.open(session.location.directory, 'HEAD');
    return this.store.read(scope.root);
  }

  async start(sessionID, options) {
    if (this.disposed) throw new Error('Review-loop plugin is unloading.');
    if (this.activeFor(sessionID)) throw new Error('A review loop is already running in this session. Use /review-loop status to follow it or /review-loop stop to cancel it.');
    const fixer = await this.ctx.session.get({ sessionID });
    if (fixer.agent !== 'build') throw new Error('Switch to the Build agent before starting a review loop.');
    if (!fixer.model) throw new Error('The fixer session must have an explicit selected model.');
    const scope = await GitScope.open(fixer.location.directory, options.base);
    const checkPolicy = options.checkPolicy ?? await checkPolicyFingerprint(scope);
    const models = await this.ctx.model.list();
    const reviewerModel = selectReviewer(models.data ?? models, fixer.model, options);
    const id = randomUUID();
    const lease = await this.store.acquire(scope.root, id);
    if (this.disposed) { await lease.release(); throw new Error('Review-loop plugin unloaded during startup.'); }
    const run = new Run({ id });
    const active = { owner: this, run, scope, lease, fixerID: sessionID, fixerModel: fixer.model, fixerAgent: fixer.agent, reviewerModel, checks: options.checks, checkPolicy, goal: options.goal, pullRequest: options.pullRequest, abort: new AbortController() };
    this.active.set(id, active);
    run.state.worktree = scope.root;
    run.state.directory = scope.cwd;
    run.state.baseSha = scope.baseSha;
    run.state.fixerID = sessionID;
    run.state.fixerModel = fixer.model;
    run.state.reviewerModel = reviewerModel;
    run.state.goal = options.goal;
    run.state.approvedChecks = options.checks;
    run.state.scopeKind = scopeKind(options);
    if (options.pullRequest) {
      const { body, title, ...identity } = options.pullRequest; // author text is passed to the reviewer, not stored in status
      run.state.pullRequest = identity;
    }
    run.state.checkPolicy = checkPolicy;
    run.state.checks = [];
    try { await lease.save(run.state); }
    catch (error) { this.active.delete(id); await lease.release(); throw error; }
    active.done = this.execute(active);
    return { id, done: active.done };
  }

  async execute(active) {
    const { run, scope, abort } = active;
    const timer = setTimeout(() => {
      void this.stop(active.fixerID, 'Overall deadline reached.').catch(() => {
        console.error(`[review-loop] Cancellation unconfirmed for run ${run.state.id}; its worktree remains locked.`);
      });
    }, RUN_TIMEOUT_MS);
    try {
      await this.ctx.session.wait({ sessionID: active.fixerID }, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(PHASE_TIMEOUT_MS)]) });
      this.ensureRunning(active);
      await this.assertSession(active, active.fixerID);
      active.initial = await scope.snapshot();
      run.state.files = active.initial.files;
      if (!active.initial.files.length) throw new Error('No changes against the selected base.');
      await this.progress(active, `Scope: ${active.initial.files.length} files against ${scope.baseSha}. Reviewer: ${active.reviewerModel.providerID}/${active.reviewerModel.id}.`);
      if (!active.checks?.length) throw new Error('Checks need approval. Re-run with explicit --check commands (for example --check "npm test"). No checks or model calls were executed.');
      while (!run.terminal) {
        this.ensureRunning(active);
        const before = await scope.snapshot();
        if (before.index !== active.initial.index) throw new Error('The Git index changed; automatic staging is not allowed.');
        const checks = [];
        run.state.checks.push({ fingerprint: before.fingerprint, results: checks });
        for (const command of active.checks) {
          this.ensureRunning(active);
          if (await checkPolicyFingerprint(scope) !== active.checkPolicy) throw new Error('Approved check definitions changed; restart and reapprove before execution.');
          await this.progress(active, `Round ${run.state.round + 1}/${run.state.maxReviews} · Checking: ${command}`);
          try { checks.push(await runCheck(command, scope.cwd, { signal: abort.signal })); }
          catch (error) {
            if (error.cleanupUnconfirmed) run.state.pendingProcessPID = error.pid;
            checks.push({ command, exitCode: error.exitCode ?? null, exitSignal: error.exitSignal ?? null, durationMs: error.durationMs ?? null, error: error.message });
            throw error;
          }
        }
        const checked = await scope.snapshot();
        await this.assertSession(active, active.fixerID);
        if (checked.fingerprint !== before.fingerprint || checked.index !== before.index) throw new Error('Verification changed source or the Git index.');
        run.checked(checked.fingerprint);
        active.changedFiles = new Set(checked.files);
        active.unreadDiffs = checked.oversized ? new Set(checked.files) : new Set();
        active.diffCursor = new Map();
        if (run.terminal) break;
        await active.lease.save(run.state);
        if (!active.reviewerID) {
          const reviewer = await this.ctx.session.create({
            parentID: active.fixerID,
            title: 'Review Loop: independent reviewer',
            agent: 'general',
            model: active.reviewerModel,
            permissions: [
              { action: '*', resource: '*', effect: 'deny' },
              { action: 'review_loop_source', resource: '*', effect: 'allow' },
              { action: 'review_loop_submit_review', resource: '*', effect: 'allow' },
            ],
          }, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(CONTROL_TIMEOUT_MS)]) });
          active.reviewerID = reviewer.id;
          if (abort.signal.aborted || run.terminal) { await this.interrupt(active, reviewer.id); throw new Error('Reviewer created after cancellation; no work scheduled.'); }
          run.state.reviewerID = reviewer.id;
          await active.lease.save(run.state);
        }
        await this.progress(active, `Round ${run.state.round}/${run.state.maxReviews} · Reviewing · session ${active.reviewerID}`);
        await this.turn(active, active.reviewerID, reviewPrompt(active, checked), 'reviewer');
        const reviewed = await scope.snapshot();
        await this.assertSession(active, active.fixerID);
        if (reviewed.index !== active.initial.index) throw new Error('Git index changed during review.');
        run.reviewCompleted(reviewed.fingerprint);
        await active.lease.save(run.state);
        if (run.state.phase === 'fixing') {
          await this.progress(active, `Round ${run.state.round}/${run.state.maxReviews} · Fixing · findings: ${JSON.stringify(run.state.issues)}`);
          await this.turn(active, active.fixerID, fixPrompt(active), 'fixer');
          run.fixCompleted();
          await active.lease.save(run.state);
        }
      }
    } catch (error) {
      run.stop(error.message || 'Review loop failed.');
    } finally {
      clearTimeout(timer);
      try { await this.progress(active, this.describe(active)); } catch (error) { active.persistenceError = error.message; }
      active.finished = true;
      try {
        await active.lease.save(run.state);
        if (run.state.pendingProcessPID) await active.lease.orphan(run.state.pendingProcessPID);
        else if (!active.pendingInterruptID) await active.lease.release();
      } catch (error) {
        active.persistenceError = error.message;
      }
      if (!active.pendingInterruptID) this.active.delete(run.state.id);
      try { await this.ctx.session.synthetic({ sessionID: active.fixerID, text: this.describe(active), resume: false }); }
      catch (error) { console.error(`[review-loop] Unable to report run ${run.state.id}: ${error.message}`); }
    }
  }

  describe(active) {
    const state = active.run.state;
    return `Review loop ${state.phase.toUpperCase()} (${state.id}), ${state.round}/${state.maxReviews} reviews.\n${state.reason || 'No outstanding blocker/major findings; required checks passed on the reviewed code.'}\nReviewer: ${active.reviewerModel.providerID}/${active.reviewerModel.id}\nFindings: ${JSON.stringify(state.issues)}${active.persistenceError ? `\nState error: ${active.persistenceError}` : ''}`;
  }

  ensureRunning(active) {
    if (active.abort.signal.aborted || active.run.terminal) throw new Error('Review loop stopped.');
  }

  async assertSession(active, sessionID) {
    const session = await this.ctx.session.get({ sessionID }, { signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) });
    if (await realpath(session.location.directory) !== active.scope.cwd) throw new Error('Session location changed.');
    const reviewer = sessionID === active.reviewerID;
    if (!sameModel(session.model, reviewer ? active.reviewerModel : active.fixerModel) || session.agent !== (reviewer ? 'general' : active.fixerAgent)) throw new Error('Session agent or model changed.');
    return session;
  }

  async turn(active, sessionID, text, role) {
    this.ensureRunning(active);
    await this.assertSession(active, sessionID);
    const signal = AbortSignal.any([active.abort.signal, AbortSignal.timeout(PHASE_TIMEOUT_MS)]);
    const before = await this.ctx.session.context({ sessionID }, { signal });
    active.turnSessionID = sessionID;
    active.scope.invalidate();
    try {
      await this.ctx.session.prompt({ sessionID, text, metadata: { reviewLoop: { id: active.run.state.id, round: active.run.state.round, role } }, delivery: 'queue' }, { signal });
      await this.ctx.session.wait({ sessionID }, { signal });
      this.ensureRunning(active);
      const session = await this.assertSession(active, sessionID);
      if (session.outcome !== 'succeeded') throw new Error(`${role} turn did not succeed.`);
      const old = new Set(before.map((message) => message.id));
      const messages = (await this.ctx.session.context({ sessionID }, { signal })).filter((message) => !old.has(message.id));
      const tools = messages.flatMap((message) => message.content ?? []).filter((part) => part.type === 'tool');
      const recovered = (part) => {
        const error = part.state?.error;
        const invalidInput = ['validation', 'invalid_input'].includes(error?.type);
        const unknownTool = error?.type === 'tool.execution' && /^No tool named "[a-zA-Z0-9_-]+" is currently available\./.test(error.message ?? '');
        const submission = role === 'reviewer' ? 'review_loop_submit_review' : 'review_loop_submit_fix';
        // A guard denial executed nothing; the fixer corrected course if a later same-tool call completed.
        const guardDenial = error?.type === 'permission.rejected' && (error.message ?? '').startsWith(DENIAL_PREFIX);
        return (invalidInput || unknownTool || guardDenial) && tools.some((later) => later.name === (unknownTool ? submission : part.name) && later.state?.status === 'completed' && tools.indexOf(later) > tools.indexOf(part));
      };
      if (messages.some((message) => message.error || (message.type === 'assistant' && ['length', 'content-filter', 'error', 'unknown'].includes(message.finish))) || tools.some((part) => part.state?.status === 'error' && !recovered(part))) throw new Error(`${role} turn had an incomplete result or unrecovered tool error.`);
    } catch (error) {
      await this.interrupt(active, sessionID);
      throw error;
    } finally { active.turnSessionID = undefined; }
  }

  submission(sessionID, input, role) {
    const active = this.activeFor(sessionID);
    if (!active || active.run.terminal || input.runId !== active.run.state.id || input.round !== active.run.state.round || sessionID !== (role === 'reviewer' ? active.reviewerID : active.fixerID) || active.turnSessionID !== sessionID) throw new Error('Submission does not belong to this active session and round.');
    return active;
  }

  async submitReview(sessionID, input) {
    const active = this.submission(sessionID, input, 'reviewer');
    await this.assertSession(active, sessionID);
    validateReview(input);
    for (const issue of input.issues) {
      const previous = active.run.state.issues.some((old) => old.id === issue.id && old.file === issue.file);
      if (active.changedFiles.has(issue.file) || previous) continue;
      if (!issue.introduced_by || !active.changedFiles.has(issue.introduced_by.file)) throw new Error('An unchanged-file finding needs introduced_by evidence anchored in the current diff.');
      for (const [path, line] of [[issue.file, issue.line], [issue.introduced_by.file, issue.introduced_by.line]]) {
        if ((await active.scope.source({ operation: 'read', path, offset: line, limit: 1 })).startsWith('[No matching')) throw new Error(`Evidence line ${path}:${line} does not exist.`);
      }
    }
    if (input.complete && active.unreadDiffs.size) {
      const shown = [...active.unreadDiffs].slice(0, 10).join(', ');
      throw new Error(`Complete review refused: the diffs of ${active.unreadDiffs.size} changed file(s) were not read to the end (${shown}${active.unreadDiffs.size > 10 ? ', …' : ''}). Read each with review_loop_source operation "diff", or submit complete=false.`);
    }
    active.run.submitReview(input, { validated: true });
    await active.lease.save(active.run.state);
  }

  async submitFix(sessionID, input) {
    const active = this.submission(sessionID, input, 'fixer');
    await this.assertSession(active, sessionID);
    active.run.submitFix(input);
    await active.lease.save(active.run.state);
  }

  async source(sessionID, input) {
    const active = this.activeFor(sessionID);
    if (!active || active.turnSessionID !== sessionID || active.run.terminal || (sessionID === active.reviewerID ? active.run.state.phase !== 'reviewing' || active.run.state.submission : active.run.state.phase !== 'fixing' || active.run.state.fix)) throw new Error('Source access is not available in this phase.');
    await this.assertSession(active, sessionID);
    if (input.operation === 'diff') {
      const page = await active.scope.fileDiff(input);
      // Coverage only advances when a page starts exactly where the previous one ended, so skipped pages never count.
      if (input.offset === undefined || input.offset === 1 || input.offset === active.diffCursor.get(input.path)) {
        active.diffCursor.set(input.path, page.next);
        if (page.complete) active.unreadDiffs.delete(input.path);
      }
      return page.text;
    }
    return active.scope.source(input);
  }

  async stop(sessionID, reason = 'Cancelled by user.') {
    const active = this.activeFor(sessionID);
    if (!active) return;
    active.run.stop(reason);
    active.abort.abort();
    const target = active.pendingInterruptID ?? active.turnSessionID;
    if (target) await this.interrupt(active, target);
    if (active.finished && !active.pendingInterruptID) {
      await active.lease.save(active.run.state);
      await active.lease.release();
      this.active.delete(active.run.state.id);
    }
  }

  async interrupt(active, sessionID) {
    active.pendingInterruptID = sessionID;
    active.run.state.pendingInterruptID = sessionID;
    await this.ctx.session.interrupt({ sessionID, resume: false }, { signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) });
    active.pendingInterruptID = undefined;
    active.run.state.pendingInterruptID = undefined;
  }

  async dispose() {
    this.disposed = true;
    await Promise.all([...this.active.values()].filter((active) => active.owner === this).map(async (active) => {
      await this.stop(active.fixerID, 'Plugin unloaded; no automatic continuation.');
      await active.done;
    }));
  }
}
