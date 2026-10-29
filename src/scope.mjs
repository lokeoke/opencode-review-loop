// The three ways a review scope is chosen. Derived from options, never from comparing a resolved SHA.
export function scopeKind(options) {
  if (options.pullRequest) return 'pull-request';
  return options.scopeKind ?? (options.base === 'HEAD' ? 'uncommitted' : 'branch');
}

export function describeScope(options, baseSha) {
  const kind = scopeKind(options);
  if (kind === 'pull-request') {
    const pr = options.pullRequest;
    return `pull request #${pr.number} (${pr.repository}), head ${pr.headSha.slice(0, 7)}`;
  }
  if (kind === 'uncommitted') return 'uncommitted changes against the pinned HEAD';
  const base = baseSha ?? options.base;
  return `branch/worktree changes against ${/^[0-9a-f]{40}$/.test(base) ? base.slice(0, 7) : base}`;
}
