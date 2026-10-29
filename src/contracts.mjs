export const MAX_FINDINGS = 100;
export const MAX_TEXT = 4000;
export const SEVERITIES = ['blocker', 'major', 'minor'];
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT) throw new Error(`Invalid ${label}.`);
}

function list(value, label) {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) throw new Error(`Invalid ${label}.`);
}

export function validateReview(value) {
  if (!value || typeof value.complete !== 'boolean') throw new Error('Review must state whether coverage is complete.');
  list(value.issues, 'issues');
  list(value.resolutions, 'resolutions');
  const ids = new Set();
  for (const issue of value.issues) {
    if (!ID.test(issue.id) || ids.has(issue.id)) throw new Error('Invalid or duplicate finding id.');
    ids.add(issue.id);
    if (!SEVERITIES.includes(issue.severity)) throw new Error('Invalid severity.');
    text(issue.file, 'file');
    if (issue.file.startsWith('/') || issue.file.includes('\\') || issue.file.split('/').some((part) => part === '..' || part === '.git' || part === '')) throw new Error('Finding path must be worktree-relative.');
    if (!Number.isSafeInteger(issue.line) || issue.line < 1) throw new Error('Invalid line.');
    for (const key of ['problem', 'failure_scenario', 'suggested_fix']) text(issue[key], key);
  }
  const resolved = new Set();
  for (const resolution of value.resolutions) {
    if (!ID.test(resolution.id) || resolved.has(resolution.id)) throw new Error('Invalid or duplicate resolution id.');
    resolved.add(resolution.id);
    if (!['fixed', 'open', 'disputed'].includes(resolution.status)) throw new Error('Invalid resolution status.');
    text(resolution.evidence, 'resolution evidence');
  }
  return value;
}

export function validateFix(value) {
  text(value?.summary, 'fix summary');
  list(value.disputed, 'disputed findings');
  if (value.disputed.some((id) => !ID.test(id))) throw new Error('Invalid disputed finding id.');
  return value;
}

const string = { type: 'string', minLength: 1, maxLength: MAX_TEXT };
const id = { type: 'string', pattern: ID.source };
function object(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
const array = (items) => ({ type: 'array', items, maxItems: MAX_FINDINGS });
export const REVIEW_SCHEMA = object({
  runId: id,
  round: { type: 'integer', minimum: 1 },
  complete: { type: 'boolean' },
  issues: array(object({ id, severity: { enum: SEVERITIES }, file: string, line: { type: 'integer', minimum: 1 }, problem: string, failure_scenario: string, suggested_fix: string })),
  resolutions: array(object({ id, status: { enum: ['fixed', 'open', 'disputed'] }, evidence: string })),
});
export const FIX_SCHEMA = object({ runId: id, round: { type: 'integer', minimum: 1 }, summary: string, disputed: array(id) });
