// Generated bundle template: the build inlines the shared RPC contract.
const { Plugin, Command } = require('@opencode/plugin/gui');
const { Rpc } = require('@opencode/plugin/rpc');
const contract = Rpc.define({"id":"review-loop","methods":{"command":{"input":{"type":"object","properties":{"sessionID":{"type":"string"},"text":{"type":"string"}},"required":["sessionID","text"],"additionalProperties":false},"output":{"type":"object","properties":{"text":{"type":"string"},"confirmation":{"type":"string"}},"required":["text"],"additionalProperties":false}}},"events":{"progress":{"schema":{"type":"object","properties":{"sessionID":{"type":"string"},"text":{"type":"string"}},"required":["sessionID","text"],"additionalProperties":false}}}});
const command = {"name":"review-loop","description":"Start, inspect, or stop a controlled Copilot review loop"};

exports.default = Plugin.define({
  setup(ctx) {
    const show = (text) => ctx.toast.show({ title: 'Review loop', description: text, duration: 10000 });
    const unsubscribe = ctx.client.rpc(contract).events.on('progress', (event) => {
      if (event.data.sessionID === ctx.sessions.current()?.id) show(event.data.text);
    });
    ctx.add(Command, {
      id: 'control', title: 'Review loop', description: command.description, slash: { name: command.name, arguments: true },
      async run(input) {
        const session = ctx.sessions.current();
        if (!session) { show('Open an existing Build session first.'); return; }
        show('Processing command…');
        try {
          let result = await ctx.client.rpc(contract).command({ sessionID: session.id, text: input || 'status' }, { location: { directory: session.directory } });
          if (result.confirmation) {
            if (!await ctx.dialogs.confirm({ title: 'Approve review scope and checks', description: result.text })) return;
            result = await ctx.client.rpc(contract).command({ sessionID: session.id, text: result.confirmation }, { location: { directory: session.directory } });
          }
          await ctx.dialogs.alert({ title: 'Review loop', description: result.text });
        } catch (error) { show(error.message); }
      },
    });
    return unsubscribe;
  },
});
