import { ReviewLoop } from './rpc.mjs';

export default {
  id: 'opencode.review-loop.tui',
  setup(context) {
    const rpc = context.client.rpc(ReviewLoop);
    const location = () => context.location ?? context.data.location.default();
    const sessionID = () => {
      const route = context.ui.router.current();
      return route?.type === 'session' ? route.sessionID : undefined;
    };
    const display = (text, variant) => context.ui.toast.show({ title: 'Review loop', message: text, ...(variant ? { variant } : {}), duration: 10_000 });
    const unsubscribe = rpc.events.on('progress', (event) => {
      if (event.data.sessionID === sessionID()) display(event.data.text);
    });
    context.keymap.layer(() => ({
      mode: 'global', priority: 20,
      commands: [{
        id: 'review-loop.control', title: 'Review loop', palette: true,
        slash: { name: 'review-loop', arguments: true },
        async run(input) {
          const id = sessionID();
          if (!id) { display('Open an existing Build session first.', 'error'); return; }
          display('Processing command…');
          try {
            let result = await rpc.command({ sessionID: id, text: input || 'status' }, { location: location() });
            if (result.confirmation) {
              if (!await context.ui.dialog.confirm({ title: 'Approve review scope and checks', message: result.text })) return;
              result = await rpc.command({ sessionID: id, text: result.confirmation }, { location: location() });
            }
            await context.ui.dialog.alert({ title: 'Review loop', message: result.text });
          } catch (error) { display(error.message, 'error'); }
        },
      }],
    }));
    return unsubscribe;
  },
};
