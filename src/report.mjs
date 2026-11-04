const BLOCKING_SEVERITIES = new Set(['blocker', 'major']);
const RECENT_PROGRESS = 6;

export function formatFinding(issue) {
  return `- [${issue.severity}] ${issue.id} ${issue.file}:${issue.line}\n  Problem: ${issue.problem}\n  Failure: ${issue.failure_scenario}\n  Fix: ${issue.suggested_fix}`;
}

export function formatFindings(issues = []) {
  return issues.length ? issues.map(formatFinding).join('\n') : 'none';
}

// Human-readable status; the raw state stays available through `status --json`.
export function formatStatus(state) {
  const lines = [`Review loop ${String(state.phase).toUpperCase()} (${state.id})`];
  lines.push(`Reviews: ${state.round}/${state.maxReviews + (state.disputeRounds ?? 0)}`);
  if (state.reason) lines.push(`Reason: ${state.reason}`);
  if (state.pullRequest) lines.push(`Pull request: #${state.pullRequest.number} ${state.pullRequest.repository ?? ''}`.trimEnd());
  if (state.files) lines.push(`Scope: ${state.files.length ?? state.files} files against ${state.baseSha ?? 'unknown base'}`);
  const checks = state.checks?.at(-1)?.results ?? [];
  lines.push(`Checks: ${checks.map((check) => `${check.command}: ${check.error ?? `exit ${check.exitCode}`}`).join('; ') || 'none completed'}`);
  for (const entry of state.history ?? []) if (entry.fix) lines.push(`Round ${entry.round} fix: ${entry.fix.summary}${entry.fix.disputed?.length ? ` (disputed: ${entry.fix.disputed.join(', ')})` : ''}`);
  if (state.omissions?.length) lines.push(`Omissions (${state.omissions.length}):`, ...state.omissions.slice(0, 10).map((entry) => `- ${entry.path}: ${entry.reason}`));
  const blocking = (state.issues ?? []).filter((issue) => BLOCKING_SEVERITIES.has(issue.severity)).length;
  lines.push(`Findings (${state.issues?.length ?? 0}, ${blocking} blocking):`, formatFindings(state.issues));
  const submitted = state.submission?.issues ?? [];
  if (state.phase === 'stopped' && submitted.length && !state.issues?.length) lines.push('Unverified findings from the interrupted review:', formatFindings(submitted));
  if (state.reviewerID) lines.push(`Reviewer session: ${state.reviewerID}`);
  if (state.reviewerNote) lines.push(`Reviewer note (model text, unverified): ${state.reviewerNote}`);
  const progress = (state.progress ?? []).slice(-RECENT_PROGRESS).map((event) => event.text ?? String(event));
  if (progress.length) lines.push('Recent progress:', ...progress.map((text) => `- ${text.slice(0, 200)}`));
  return lines.join('\n');
}
