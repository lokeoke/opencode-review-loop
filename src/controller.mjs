import { MAX_TEXT, validateFix, validateReview } from './contracts.mjs';

export const MAX_REVIEWS = 4;
export const BLOCKING = new Set(['blocker', 'major']);
const TERMINAL = new Set(['passed', 'stopped']);

export class Run {
  constructor({ id, maxReviews = MAX_REVIEWS }) {
    this.state = { id, phase: 'checking', round: 0, maxReviews, issues: [], history: [] };
  }

  get terminal() { return TERMINAL.has(this.state.phase); }

  requirePhase(phase) {
    if (this.state.phase !== phase) throw new Error(`Expected ${phase}; run is ${this.state.phase}.`);
  }

  checked(fingerprint) {
    this.requirePhase('checking');
    if (this.state.history.some((entry) => entry.fingerprint === fingerprint)) return this.stop('No code progress or fix/revert oscillation.');
    this.state.fingerprint = fingerprint;
    this.state.phase = 'reviewing';
    this.state.round += 1;
    this.state.submission = undefined;
    this.state.fix = undefined;
  }

  submitReview(result, { validated = false } = {}) {
    this.requirePhase('reviewing');
    if (this.state.submission) throw new Error('Review already submitted.');
    this.state.submission = structuredClone(validated ? result : validateReview(result));
  }

  reviewCompleted(fingerprint) {
    this.requirePhase('reviewing');
    if (fingerprint !== this.state.fingerprint) return this.stop('Code changed during review.');
    const result = this.state.submission;
    if (!result) return this.stop('Missing review.');
    if (!result.complete) return this.stop(`Incomplete review${result.limitations.length ? `: ${result.limitations.join(' ').slice(0, MAX_TEXT)}` : '.'}`);
    const previous = this.state.issues.filter((issue) => BLOCKING.has(issue.severity));
    for (const issue of previous) {
      const resolution = result.resolutions.find((item) => item.id === issue.id);
      if (!resolution || resolution.status === 'disputed') return this.stop('Explicit resolution required for every previous blocking finding.');
      const current = result.issues.find((item) => item.id === issue.id);
      if ((resolution.status === 'fixed' && current) || (resolution.status === 'open' && !BLOCKING.has(current?.severity))) return this.stop('Inconsistent finding resolution.');
    }
    const blockingIds = (issues) => issues.filter((issue) => BLOCKING.has(issue.severity)).map((issue) => issue.id).sort().join(',');
    const repeated = previous.length && blockingIds(previous) === blockingIds(result.issues);
    this.state.issues = result.issues;
    this.state.history.push({ round: this.state.round, fingerprint, review: result });
    if (repeated) return this.stop('No progress: the same blocking findings remain.');
    if (blockingIds(result.issues) && this.state.round >= this.state.maxReviews) return this.stop('Review limit reached with blocking findings.');
    this.state.phase = result.issues.some((issue) => BLOCKING.has(issue.severity)) ? 'fixing' : 'passed';
  }

  submitFix(result) {
    this.requirePhase('fixing');
    if (this.state.fix) throw new Error('Fix already submitted.');
    this.state.fix = structuredClone(validateFix(result));
  }

  fixCompleted() {
    this.requirePhase('fixing');
    if (!this.state.fix || this.state.fix.disputed.length) return this.stop('Fix missing or findings disputed; human decision needed.');
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
