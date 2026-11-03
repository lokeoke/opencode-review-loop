import { MAX_TEXT, validateFix, validateReview } from './contracts.mjs';

export const MAX_REVIEWS = 4;
export const MAX_REVIEWS_CEILING = 10;
export const BLOCKING = new Set(['blocker', 'major']);
export const TERMINAL_PHASES = new Set(['passed', 'incomplete', 'stopped']);

export class Run {
  constructor({ id, maxReviews = MAX_REVIEWS }) {
    this.state = { id, phase: 'checking', round: 0, maxReviews, issues: [], history: [] };
  }

  get terminal() { return TERMINAL_PHASES.has(this.state.phase); }

  // Judging a dispute re-reviews unchanged code, so it does not spend the review budget.
  get reviewsUsed() { return this.state.round - (this.state.disputeRounds ?? 0); }

  requirePhase(phase) {
    if (this.state.phase !== phase) throw new Error(`Expected ${phase}; run is ${this.state.phase}.`);
  }

  checked(fingerprint) {
    this.requirePhase('checking');
    // Code unchanged since a review with no blocking findings (a minor fix pass that edited nothing): that
    // review and the checks just run on the same code stand, so the run passes instead of looping.
    const last = this.state.history.at(-1);
    // A disputed blocker changes no code: the reviewer judges the fixer's rationale against the same fingerprint.
    const judgingDispute = this.state.pendingDisputes?.length && last?.fingerprint === fingerprint;
    if (!judgingDispute && last?.fingerprint === fingerprint && !last.review.issues.some((issue) => BLOCKING.has(issue.severity))) {
      this.finish();
      return;
    }
    if (!judgingDispute && this.state.history.some((entry) => entry.fingerprint === fingerprint)) return this.stop('No code progress or fix/revert oscillation.');
    this.state.fingerprint = fingerprint;
    this.state.phase = 'reviewing';
    this.state.round += 1;
    if (judgingDispute) this.state.disputeRounds = (this.state.disputeRounds ?? 0) + 1;
    this.state.submission = undefined;
    this.state.fix = undefined;
  }

  submitReview(result, { validated = false } = {}) {
    this.requirePhase('reviewing');
    if (this.state.submission) throw new Error('Review already submitted.');
    this.state.submission = structuredClone(validated ? result : validateReview(result));
  }

  retryReview() {
    this.requirePhase('reviewing');
    if (!this.state.submission || this.state.submission.complete) throw new Error('Only an incomplete submitted review can be retried.');
    this.state.submission = undefined;
  }

  reviewCompleted(fingerprint) {
    this.requirePhase('reviewing');
    if (fingerprint !== this.state.fingerprint) return this.stop('Code changed during review.');
    const result = this.state.submission;
    if (!result) return this.stop('Missing review.');
    if (!result.complete) {
      // Partial review cannot resolve earlier findings or schedule a fix, but its findings remain useful.
      this.state.issues = [...result.issues, ...this.state.issues.filter((old) => !result.issues.some((issue) => issue.id === old.id))];
      this.state.history.push({ round: this.state.round, fingerprint, review: result });
      this.state.phase = 'incomplete';
      this.state.reason = `Incomplete review${result.limitations.length ? `: ${result.limitations.join(' ').slice(0, MAX_TEXT)}` : '.'}${this.omissionNote()}`;
      return;
    }
    const previous = this.state.issues.filter((issue) => BLOCKING.has(issue.severity));
    const hadDispute = Boolean(this.state.pendingDisputes?.length);
    for (const issue of previous) {
      const resolution = result.resolutions.find((item) => item.id === issue.id);
      if (!resolution || resolution.status === 'disputed') return this.stop('Explicit resolution required for every previous blocking finding.');
      const current = result.issues.find((item) => item.id === issue.id);
      const withdrawnWithoutDispute = resolution.status === 'withdrawn' && !this.state.pendingDisputes?.some((entry) => entry.id === issue.id);
      if (((resolution.status === 'fixed' || resolution.status === 'withdrawn') && current) || withdrawnWithoutDispute || (resolution.status === 'open' && !BLOCKING.has(current?.severity))) return this.stop('Inconsistent finding resolution.');
    }
    const blockingIds = (issues) => issues.filter((issue) => BLOCKING.has(issue.severity)).map((issue) => issue.id).sort().join(',');
    const repeated = previous.length && blockingIds(previous) === blockingIds(result.issues);
    // Minor findings get exactly one fix attempt: a minor already reported in an earlier round never holds the run.
    const seen = new Set(this.state.history.flatMap((entry) => entry.review.issues.map((issue) => issue.id)));
    const newMinor = result.issues.some((issue) => !BLOCKING.has(issue.severity) && !seen.has(issue.id));
    this.state.issues = result.issues;
    this.state.history.push({ round: this.state.round, fingerprint, review: result });
    if (hadDispute) this.state.pendingDisputes = [];
    // A rejected dispute earns one more fix pass instead of the no-progress stop.
    if (repeated && !hadDispute) return this.stop('No progress: the same blocking findings remain.');
    if (blockingIds(result.issues) && this.reviewsUsed >= this.state.maxReviews) return this.stop('Review limit reached with blocking findings.');
    const blocking = result.issues.some((issue) => BLOCKING.has(issue.severity));
    if (blocking || (newMinor && this.reviewsUsed < this.state.maxReviews)) this.state.phase = 'fixing';
    else this.finish();
  }

  omissionNote() {
    const count = this.state.omissions?.length;
    return count ? ` ${count} selected file(s) unavailable; see omissions.` : '';
  }

  // Omitted files are never verified, so they can end a run INCOMPLETE but never PASSED.
  finish() {
    if (!this.state.omissions?.length) { this.state.phase = 'passed'; return; }
    this.state.phase = 'incomplete';
    this.state.reason = `No outstanding blocker/major findings in the inspected files.${this.omissionNote()}`;
  }

  // Findings for the next fix pass: every blocking one, plus minor ones not reported in an earlier round.
  fixTargets() {
    const earlier = new Set(this.state.history.slice(0, -1).flatMap((entry) => entry.review.issues.map((issue) => issue.id)));
    return this.state.issues.filter((issue) => BLOCKING.has(issue.severity) || !earlier.has(issue.id));
  }

  submitFix(result) {
    this.requirePhase('fixing');
    if (this.state.fix) throw new Error('Fix already submitted.');
    this.state.fix = structuredClone(validateFix(result));
  }

  fixCompleted() {
    this.requirePhase('fixing');
    if (!this.state.fix) return this.stop('Fix missing; human decision needed.');
    // A disputed minor finding is recorded for the report; a disputed blocker is judged once by the reviewer, then needs a human.
    const blockingIds = new Set(this.state.issues.filter((issue) => BLOCKING.has(issue.severity)).map((issue) => issue.id));
    const disputedBlocking = this.state.fix.disputed.filter((id) => blockingIds.has(id));
    const alreadyJudged = this.state.disputedIds ?? [];
    if (disputedBlocking.some((id) => alreadyJudged.includes(id))) return this.stop('Blocking findings disputed; human decision needed.');
    if (disputedBlocking.length) {
      this.state.disputedIds = [...alreadyJudged, ...disputedBlocking];
      this.state.pendingDisputes = disputedBlocking.map((id) => ({ id, rationale: this.state.fix.summary }));
    }
    this.state.history.at(-1).fix = this.state.fix;
    this.state.phase = 'checking';
  }

  stop(reason) {
    if (this.terminal) return;
    this.state.stoppedPhase = this.state.phase;
    this.state.phase = 'stopped';
    this.state.reason = reason;
  }
}
