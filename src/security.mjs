const SOURCE = 'review_loop_source';
const REVIEW = 'review_loop_submit_review';
const FIX = 'review_loop_submit_fix';
const EDIT_TOOLS = ['patch', 'edit', 'write'];
export const DENIAL_PREFIX = 'Denied by review-loop policy:';

function allowedTools(active, sessionID) {
  if (active.run.terminal) return [];
  if (sessionID === active.reviewerID && active.run.state.phase === 'reviewing' && !active.run.state.submission) return [SOURCE, REVIEW];
  if (sessionID === active.fixerID && active.run.state.phase === 'fixing' && !active.run.state.fix) return [SOURCE, FIX, ...EDIT_TOOLS];
  return [];
}

export async function installGuards(ctx, engine) {
  await ctx.session.hook('context', (event) => {
    const active = engine.activeFor(event.sessionID);
    if (!active) return;
    const allowed = allowedTools(active, event.sessionID);
    for (const name of Object.keys(event.tools)) if (!allowed.includes(name)) delete event.tools[name];
  });
  await ctx.permission.hook('evaluate', async (event) => {
    const active = engine.activeFor(event.sessionID);
    if (!active) return;
    const allowed = allowedTools(active, event.sessionID);
    if ([SOURCE, REVIEW, FIX].includes(event.action) && allowed.includes(event.action)) return;
    let reasons = ['not permitted in the active review-loop phase'];
    if (event.action === 'edit' && allowed.includes('patch')) {
      try {
        await engine.assertSession(active, event.sessionID);
        reasons = (await Promise.all(event.resources.map(async (path) => {
          const reason = await active.scope.editDenial(path);
          return reason && `${JSON.stringify(path)}: ${reason}`;
        }))).filter(Boolean);
        if (!event.resources.length) reasons.push('no resource was supplied');
        if (!reasons.length) return;
      } catch (error) { reasons = [`session identity could not be verified (${error.message})`]; }
    }
    engine.recordDenial?.(active, event.action, event.resources, reasons);
    event.effect = 'deny';
    event.message = `${DENIAL_PREFIX} ${event.action}: ${reasons.join('; ')}`;
  });
  await ctx.session.hook('prompt', async (event) => {
    const active = engine.activeFor(event.sessionID);
    if (!active) return;
    const metadata = event.metadata?.reviewLoop;
    if (metadata?.id === active.run.state.id && metadata.round === active.run.state.round && event.sessionID === active.turnSessionID) return;
    await engine.stop(event.sessionID, 'New user input interrupted the automatic review loop.');
  });
}
