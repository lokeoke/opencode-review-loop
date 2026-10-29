import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ReviewLoop } from '../src/rpc.mjs';
import { COMMAND_DESCRIPTION, COMMAND_NAME } from '../src/command.mjs';

// No JSX or dependencies to bundle: emit a single CJS file using host-provided SDK modules.
const root = new URL('../', import.meta.url);
await mkdir(new URL('dist/', root), { recursive: true });
const source = await readFile(new URL('src/gui-template.cjs', root), 'utf8');
await writeFile(new URL('dist/gui-experimental.cjs', root), source.replace('__REVIEW_LOOP_CONTRACT__', () => JSON.stringify(ReviewLoop)).replace('__REVIEW_LOOP_COMMAND__', () => JSON.stringify({ name: COMMAND_NAME, description: COMMAND_DESCRIPTION })));
console.log(`Built ${fileURLToPath(new URL('dist/gui-experimental.cjs', root))}`);
