import { Engine } from './engine.mjs';
import { parseCommand } from './options.mjs';
import { FIX_SCHEMA, REVIEW_SCHEMA } from './contracts.mjs';
import { installGuards } from './security.mjs';
import { permissionGate } from './compatibility.mjs';
import { ReviewLoop } from './rpc.mjs';
import { inspectScope, prepare } from './preflight.mjs';
import { resolvePullRequest } from './pr.mjs';
import { describeScope, scopeKind } from './scope.mjs';
import { checkPolicyFingerprint } from './check-policy.mjs';
import { randomUUID } from 'node:crypto';

const SOURCE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['operation'],
  properties: {
    operation: { type: 'string', enum: ['list', 'read', 'search', 'diff'] },
    path: { type: 'string', maxLength: 1000 },
    query: { type: 'string', maxLength: 200 },
    offset: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
};
const APPROVAL_TTL_MS = 10 * 60_000;

export function createPlugin(dependencies = {}) {
  return {
    id: 'review-loop',
    async setup(ctx) {
      let assertPermission, compatibilityError;
      try { assertPermission = permissionGate(ctx); } catch (error) { compatibilityError = error; }
      const engine = new Engine(ctx);
      const approvals = new Map();
      await installGuards(ctx, engine);
      await ctx.tool.transform((editor) => {
        for (const [name, description, schema, handle] of [
          ['review_loop_source', 'Read/list/search worktree-relative source, or page one changed file\'s diff (operation diff). Literal search; paginate with offset/limit. No edits or shell.', SOURCE_SCHEMA, (sessionID, input) => engine.source(sessionID, input)],
          ['review_loop_submit_review', 'Submit one structured review for the active run and round, then finish immediately.', REVIEW_SCHEMA, (sessionID, input) => engine.submitReview(sessionID, input)],
          ['review_loop_submit_fix', 'Submit a fix summary and disputed finding IDs, then finish immediately.', FIX_SCHEMA, (sessionID, input) => engine.submitFix(sessionID, input)],
        ]) {
          editor.add({
            name, description, input: schema, options: { codemode: false },
            async execute(input, context) {
              if (compatibilityError) throw compatibilityError;
              await assertPermission({ sessionID: context.sessionID, agent: context.agent, action: name, resources: ['*'], source: { type: 'tool', messageID: context.messageID, id: context.id } });
              const result = await handle(context.sessionID, input);
              return { content: result ?? 'Submission recorded provisionally. Finish this turn now; the controller owns the next step.' };
            },
          });
        }
      });
      const command = async ({ sessionID, text: argumentsText }) => {
        let text;
        try {
          let options = parseCommand(argumentsText);
        let approved = false;
        // A pull request fixes the base and scope. Resolution never changes the checkout.
        const withPullRequest = async (parsed) => {
          if (!parsed.pr) return parsed;
          const session = await ctx.session.get({ sessionID });
          const pullRequest = await resolvePullRequest(parsed.pr, session.location.directory, dependencies);
          return { ...parsed, base: pullRequest.baseSha, pullRequest };
        };
          if (options.action === 'start') {
            if (compatibilityError) throw compatibilityError;
            if (options.confirm) {
              const approval = approvals.get(sessionID);
              approvals.delete(sessionID);
              if (!approval || approval.token !== options.confirm || Date.now() > approval.expires) throw new Error('Approval expired or does not belong to this session. Run start again.');
              if (approval.options.pr) {
                const fresh = (await withPullRequest(approval.options)).pullRequest;
                const approved = approval.options.pullRequest;
                if (fresh.headSha !== approved.headSha || fresh.baseSha !== approved.baseSha || fresh.state !== approved.state || fresh.title !== approved.title) throw new Error(`Pull request #${approved.number} changed since approval. Run start again.`);
              }
              const session = await ctx.session.get({ sessionID });
              const current = await inspectScope(session.location.directory, approval.options);
              if (current.scope.root !== approval.root || current.scope.cwd !== approval.directory || current.snapshot.fingerprint !== approval.fingerprint || current.snapshot.index !== approval.index) throw new Error('Scope changed since approval. Run start again.');
              if (await checkPolicyFingerprint(current.scope) !== approval.options.checkPolicy) throw new Error('Check definitions changed since approval. Run start again.');
              options = approval.options;
              approved = true;
            } else if (!options.checks.length) {
              const session = await ctx.session.get({ sessionID });
              options = await withPullRequest(options);
              const proposed = await prepare(session.location.directory, options);
              const pr = options.pullRequest;
              const prLines = pr ? `Title: ${pr.title}\n${pr.isDraft ? 'Draft pull request. ' : ''}${pr.warnings.join(' ')}\n` : '';
              const text = `Scope: ${describeScope(options, proposed.scope.baseSha)}\n${prLines}Checkout: ${proposed.scope.root}\nBase: ${proposed.scope.baseSha}\nFiles (${proposed.snapshot.files.length} total; first 40 shown):\n${proposed.snapshot.files.slice(0, 40).join('\n')}\n\nProposed checks: ${proposed.checks.join('; ') || 'none found'}\nScript definitions (including pre/post hooks):\n${proposed.definitions.join('\n')}\nNo commands or models have run. Approve only if all these changes belong to your task.`;
              if (!proposed.checks.length) return { text: text + '\nSupply an explicit --check command to continue.' };
              const token = randomUUID();
              approvals.set(sessionID, { token, root: proposed.scope.root, directory: proposed.scope.cwd, fingerprint: proposed.snapshot.fingerprint, index: proposed.snapshot.index, expires: Date.now() + APPROVAL_TTL_MS, options: { ...options, scopeKind: scopeKind(options), base: proposed.scope.baseSha, checks: proposed.checks, checkPolicy: proposed.checkPolicy } });
              return { text, confirmation: `start --confirm ${token}` };
            }
            if (!approved) {
              options = await withPullRequest(options);
              if (options.pullRequest?.isCrossRepository) throw new Error('This is a fork pull request: its checks run contributor code. Start without --check so the checks are shown for approval first.');
              if (options.pullRequest) await inspectScope((await ctx.session.get({ sessionID })).location.directory, options);
            }
            const { id } = await engine.start(sessionID, options);
            const warnings = options.pullRequest?.warnings.length ? ` Warning: ${options.pullRequest.warnings.join(' ')}` : '';
            text = `Review loop started: ${id}. Scope: ${describeScope(options)}.${warnings} No goal required. Checks: ${options.checks.join('; ') || 'approval needed; no commands will run'}. Use status or stop. No automatic Git commits, pushes, or merges.`;
          } else if (options.action === 'stop') {
            await engine.stop(sessionID);
            text = 'Cancellation requested; inspect progress for completion. Unconfirmed cleanup retains the lock.';
          } else {
            const state = await engine.status(sessionID);
            text = state ? JSON.stringify(state, null, 2) : 'No review loop recorded for this worktree.';
          }
        } catch (error) { text = `Review loop: ${error.message}\nUsage: /review-loop [<pull request URL or number>] [--base main] [--check "npm test"] | status | stop`; }
        return { text };
      };
      // The TUI and Desktop parts own the /review-loop slash command and call this RPC. Registering a slash command here
      // as well would show two rows with different behaviour.
      if (ctx.rpc?.register) {
        const registration = await ctx.rpc.register(ReviewLoop, { command });
        engine.report = (sessionID, text) => registration.events.emit('progress', { sessionID, text });
      } else console.warn('[review-loop] This host offers no plugin RPC, so no /review-loop command is available. Check that the plugin reports its tui or gui part as active.');
      return () => engine.dispose();

    },
  };
}

export default createPlugin();
