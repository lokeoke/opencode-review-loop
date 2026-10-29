export default {
  id: 'opencode.review-loop',
  async setup(ctx) {
    await ctx.command.transform((editor) => {
      editor.add({
        name: 'review-loop',
        description: 'Start, inspect, or stop a controlled Copilot review loop',
        async execute() {
          throw new Error('Review-loop controller is not configured yet.');
        },
      });
    });
    return async () => {};
  },
};
