import { Engine } from './engine.mjs';
import { parseCommand } from './options.mjs';
import { FIX_SCHEMA, REVIEW_SCHEMA } from './contracts.mjs';
import { installGuards } from './security.mjs';

const SOURCE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['operation'],
  properties: {
    operation: { type: 'string', enum: ['list', 'read', 'search'] },
    path: { type: 'string', maxLength: 1000 },
    query: { type: 'string', maxLength: 200 },
    offset: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
};

export default {
  id: 'opencode.review-loop',
  async setup(ctx) {
    const engine = new Engine(ctx);
    await installGuards(ctx, engine);
    await ctx.tool.transform((editor) => {
      for (const [name, description, schema, handle] of [
        ['review_loop_source', 'Read/list/search worktree-relative source. Literal search; paginate with offset/limit. No edits or shell.', SOURCE_SCHEMA, (sessionID, input) => engine.source(sessionID, input)],
        ['review_loop_submit_review', 'Submit one structured review for the active run and round, then finish immediately.', REVIEW_SCHEMA, (sessionID, input) => engine.submitReview(sessionID, input)],
        ['review_loop_submit_fix', 'Submit a fix summary and disputed finding IDs, then finish immediately.', FIX_SCHEMA, (sessionID, input) => engine.submitFix(sessionID, input)],
      ]) {
        editor.add({
          name, description, input: schema, options: { codemode: false },
          async execute(input, context) {
            await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, action: name, resources: ['*'], source: { type: 'tool', messageID: context.messageID, id: context.id } });
            const result = await handle(context.sessionID, input);
            return { content: result ?? 'Submission recorded provisionally. Finish this turn now; the controller owns the next step.' };
          },
        });
      }
    });
    await ctx.command.transform((editor) => {
      editor.add({
        name: 'review-loop',
        description: 'Start, inspect, or stop a controlled Copilot review loop',
        async execute({ sessionID, prompt }) {
          let text;
          try {
            const options = parseCommand(prompt.text);
            if (options.action === 'start') {
              const { id } = await engine.start(sessionID, options);
              text = `Review loop started: ${id}. Checks are explicitly authorized for this run. Use /review-loop status or /review-loop stop. No automatic Git commits, pushes, or merges.`;
            } else if (options.action === 'stop') {
              await engine.stop(sessionID);
              text = 'Review-loop cancellation requested. No further automatic turns will be scheduled.';
            } else {
              const state = await engine.status(sessionID);
              text = state ? JSON.stringify(state, null, 2) : 'No review loop recorded for this worktree.';
            }
          } catch (error) { text = `Review loop: ${error.message}\nUsage: /review-loop start --base main --goal "requirements" --check "npm test"`; }
          await ctx.session.synthetic({ sessionID, text, resume: false });
        },
      });
    });
    return () => engine.dispose();
  },
};
