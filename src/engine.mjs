import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { Run } from './controller.mjs';
import { GitScope } from './git.mjs';
import { RunStore } from './storage.mjs';
import { selectReviewer } from './options.mjs';
import { runCheck } from './checks.mjs';
import { fixPrompt, reviewPrompt } from './prompts.mjs';

export const PHASE_TIMEOUT_MS = 10 * 60_000;
export const RUN_TIMEOUT_MS = 45 * 60_000;

function sameModel(a, b) { return a?.providerID === b?.providerID && a?.id === b?.id && (a?.variant ?? 'default') === (b?.variant ?? 'default'); }

export class Engine {
  constructor(ctx, { stateDirectory } = {}) {
    this.ctx = ctx;
    this.store = new RunStore(stateDirectory);
    this.active = new Map();
    this.disposed = false;
  }

  activeFor(sessionID) {
    return [...this.active.values()].find((item) => item.fixerID === sessionID || item.reviewerID === sessionID);
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
    const fixer = await this.ctx.session.get({ sessionID });
    if (fixer.agent !== 'build') throw new Error('Switch to the Build agent before starting a review loop.');
    if (!fixer.model) throw new Error('The fixer session must have an explicit selected model.');
    const scope = await GitScope.open(fixer.location.directory, options.base);
    const models = await this.ctx.model.list();
    const reviewerModel = selectReviewer(models.data ?? models, fixer.model, options);
    const id = randomUUID();
    const lease = await this.store.acquire(scope.root, id);
    const run = new Run({ id });
    const active = { run, scope, lease, fixerID: sessionID, fixerModel: fixer.model, fixerAgent: fixer.agent, reviewerModel, checks: options.checks, goal: options.goal, abort: new AbortController() };
    this.active.set(id, active);
    run.state.worktree = scope.root;
    run.state.directory = scope.cwd;
    run.state.baseSha = scope.baseSha;
    run.state.fixerID = sessionID;
    run.state.fixerModel = fixer.model;
    run.state.reviewerModel = reviewerModel;
    run.state.checks = [];
    try { await lease.save(run.state); }
    catch (error) { this.active.delete(id); await lease.release(); throw error; }
    active.done = this.execute(active);
    return { id, done: active.done };
  }

  async execute(active) {
    const { run, scope, abort } = active;
    const timer = setTimeout(() => { void this.stop(active.fixerID, 'Overall deadline reached.'); }, RUN_TIMEOUT_MS);
    try {
      await this.ctx.session.wait({ sessionID: active.fixerID }, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(PHASE_TIMEOUT_MS)]) });
      active.initial = await scope.snapshot();
      if (!active.initial.files.length) throw new Error('No changes against the selected base.');
      while (!run.terminal) {
        this.ensureRunning(active);
        const before = await scope.snapshot();
        if (before.index !== active.initial.index) throw new Error('The Git index changed; automatic staging is not allowed.');
        const checks = [];
        for (const command of active.checks) {
          this.ensureRunning(active);
          checks.push(await runCheck(command, scope.cwd, { signal: abort.signal }));
        }
        const checked = await scope.snapshot();
        if (checked.fingerprint !== before.fingerprint || checked.index !== before.index) throw new Error('Verification changed source or the Git index.');
        run.state.checks.push({ fingerprint: checked.fingerprint, results: checks });
        run.checked(checked.fingerprint);
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
          });
          active.reviewerID = reviewer.id;
          run.state.reviewerID = reviewer.id;
          await active.lease.save(run.state);
        }
        await this.turn(active, active.reviewerID, reviewPrompt(active, checked), 'reviewer');
        const reviewed = await scope.snapshot();
        if (reviewed.index !== active.initial.index) throw new Error('Git index changed during review.');
        run.reviewCompleted(reviewed.fingerprint);
        await active.lease.save(run.state);
        if (run.state.phase === 'fixing') {
          await this.turn(active, active.fixerID, fixPrompt(active), 'fixer');
          run.fixCompleted();
          await active.lease.save(run.state);
        }
      }
    } catch (error) {
      run.stop(error.message || 'Review loop failed.');
    } finally {
      clearTimeout(timer);
      try {
        await active.lease.save(run.state);
        await active.lease.release();
      } catch (error) {
        active.persistenceError = error.message;
      }
      this.active.delete(run.state.id);
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
    const session = await this.ctx.session.get({ sessionID });
    if (await realpath(session.location.directory) !== active.scope.cwd) throw new Error('Session location changed.');
    const reviewer = sessionID === active.reviewerID;
    if (!sameModel(session.model, reviewer ? active.reviewerModel : active.fixerModel) || session.agent !== (reviewer ? 'general' : active.fixerAgent)) throw new Error('Session agent or model changed.');
    return session;
  }

  async turn(active, sessionID, text, role) {
    this.ensureRunning(active);
    await this.assertSession(active, sessionID);
    const before = await this.ctx.session.context({ sessionID });
    const signal = AbortSignal.any([active.abort.signal, AbortSignal.timeout(PHASE_TIMEOUT_MS)]);
    active.turnSessionID = sessionID;
    try {
      await this.ctx.session.prompt({ sessionID, text, metadata: { reviewLoop: { id: active.run.state.id, round: active.run.state.round, role } }, delivery: 'queue' });
      await this.ctx.session.wait({ sessionID }, { signal });
      this.ensureRunning(active);
      const session = await this.assertSession(active, sessionID);
      if (session.outcome !== 'succeeded') throw new Error(`${role} turn did not succeed.`);
      const old = new Set(before.map((message) => message.id));
      const messages = (await this.ctx.session.context({ sessionID })).filter((message) => !old.has(message.id));
      if (messages.some((message) => message.error || (message.type === 'assistant' && ['length', 'content-filter', 'error', 'unknown'].includes(message.finish)) || message.content?.some((part) => part.state?.status === 'error'))) throw new Error(`${role} turn had an incomplete result or tool error.`);
    } catch (error) {
      await this.ctx.session.interrupt({ sessionID, resume: false });
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
    const snapshot = await active.scope.snapshot();
    if (input.issues.some((issue) => !snapshot.files.includes(issue.file))) throw new Error('Findings must point to a changed file in this review scope.');
    active.run.submitReview(input);
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
    return active.scope.source(input);
  }

  async stop(sessionID, reason = 'Cancelled by user.') {
    const active = this.activeFor(sessionID);
    if (!active) return;
    active.run.stop(reason);
    active.abort.abort();
    if (active.turnSessionID) await this.ctx.session.interrupt({ sessionID: active.turnSessionID, resume: false });
  }

  async dispose() {
    this.disposed = true;
    await Promise.all([...this.active.values()].map(async (active) => {
      await this.stop(active.fixerID, 'Plugin unloaded; no automatic continuation.');
      await active.done;
    }));
  }
}
