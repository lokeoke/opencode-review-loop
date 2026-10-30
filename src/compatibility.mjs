export function permissionGate(ctx) {
  if (typeof ctx.permission?.assert === 'function') return (input) => ctx.permission.assert(input);
  if (typeof ctx.session?.permission?.create === 'function') return async (input) => {
    const response = await ctx.session.permission.create(input);
    if ((response?.data ?? response)?.effect !== 'allow') throw new Error('Review-loop permission was not explicitly allowed.');
  };
  throw new Error('Unsupported OpenCode permission API; review loop cannot safely start.');
}
