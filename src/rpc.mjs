// Rpc.define is an identity helper; plain JSON Schema keeps this contract dependency-free.
export const ReviewLoop = {
  id: 'review-loop',
  methods: {
    command: {
      input: { type: 'object', properties: { sessionID: { type: 'string' }, text: { type: 'string' } }, required: ['sessionID', 'text'], additionalProperties: false },
      output: { type: 'object', properties: { text: { type: 'string' }, confirmation: { type: 'string' } }, required: ['text'], additionalProperties: false },
    },
  },
  events: {
    progress: { schema: { type: 'object', properties: { sessionID: { type: 'string' }, text: { type: 'string' } }, required: ['sessionID', 'text'], additionalProperties: false } },
  },
};
