import { parsePullRequestRef } from './pr.mjs';

export const COPILOT = 'github-copilot';
const PREFERENCES = ['claude-sonnet-5.5', 'gpt-6.1-sol', 'gemini-4-argon'];

function tokenize(input) {
  const tokens = [];
  let token = '', quote, escaped = false, started = false;
  const source = input.trim();
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (escaped) { token += char; escaped = false; started = true; }
    else if (char === '\\' && quote !== "'" && (!quote || ['"', '\\', '$', '`', '\n'].includes(source[i + 1]))) { escaped = true; started = true; }
    else if (quote) { if (char === quote) quote = undefined; else token += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) tokens.push(token); token = ''; started = false; }
    else { token += char; started = true; }
  }
  if (quote || escaped) throw new Error('Unclosed quote or escape in arguments.');
  if (started) tokens.push(token);
  return tokens;
}

export function parseCommand(input = '') {
  const [action = 'status', ...args] = tokenize(input);
  if (!['start', 'status', 'stop'].includes(action)) throw new Error('Use start, status, or stop.');
  if (action !== 'start') {
    if (args.length) throw new Error(`${action} takes no arguments.`);
    return { action };
  }
  const result = { action, base: 'HEAD', checks: [], allowSameFamily: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith('--')) {
      const pr = parsePullRequestRef(key);
      if (!pr) throw new Error(`Unknown argument: ${key}. Use a pull request URL (https://github.com/owner/repo/pull/N), a pull request number, or an option.`);
      if (result.pr) throw new Error('Only one pull request can be reviewed at a time.');
      result.pr = pr;
      continue;
    }
    if (key === '--allow-same-family') { result.allowSameFamily = true; continue; }
    if (key === '--include-uncommitted') { result.includeUncommitted = true; continue; }
    if (!['--base', '--goal', '--check', '--reviewer', '--confirm'].includes(key)) throw new Error(`Unknown option: ${key}`);
    if (key !== '--check' && seen.has(key)) throw new Error(`Duplicate option: ${key}`);
    seen.add(key);
    const value = args[++i];
    if (!value?.trim() || value.startsWith('--') || value.includes('\0') || value.length > 8000) throw new Error(`Missing or invalid value for ${key}.`);
    if (key === '--check') result.checks.push(value);
    else result[key.slice(2)] = value;
  }
  if (result.pr && seen.has('--base')) throw new Error('A pull request defines its own base; remove --base.');
  if (result.checks.length > 10) throw new Error('Provide at most 10 explicit --check commands.');
  if (result.base.startsWith('-')) throw new Error('Base cannot be an option.');
  return result;
}

export function lineage(id) {
  if (/^(gpt|o[0-9])/.test(id)) return 'openai';
  if (/^claude/.test(id)) return 'anthropic';
  if (/^gemini/.test(id)) return 'google';
  return undefined;
}

export function selectReviewer(models, fixer, options = {}) {
  const available = models.filter((model) => model.providerID === COPILOT && model.enabled !== false && model.status !== 'deprecated' && model.capabilities?.tools);
  const references = options.reviewer ? [options.reviewer.replace(`${COPILOT}/`, '')] : PREFERENCES;
  if (options.reviewer?.includes('/') && !options.reviewer.startsWith(`${COPILOT}/`)) throw new Error('Reviewer must use GitHub Copilot.');
  const candidates = references.map((id) => available.find((model) => model.id === id)).filter(Boolean);
  const selected = candidates.find((model) => lineage(model.id) && lineage(fixer.id) && lineage(model.id) !== lineage(fixer.id))
    ?? (options.allowSameFamily ? candidates[0] : undefined);
  if (!selected) throw new Error('No approved different-lineage Copilot reviewer available. Select --reviewer or explicitly --allow-same-family.');
  return { providerID: selected.providerID, id: selected.id };
}
