// Assembles programs/<NAME>.ASM with the bundled DRI ASM and LOAD, running
// inside the emulator, and writes programs/<NAME>.COM.
// Usage: npx vite-node scripts/assemble.ts COLOR TETRIS   (then npm run embed)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble } from '../src/cpm/assembler';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const name of process.argv.slice(2)) {
  const src = readFileSync(`${root}/programs/${name}.ASM`, 'latin1');
  const result = await assemble(name, src);
  console.log(result.listing.trim());
  if (!result.ok) { console.error(`${name}: assembly failed\n${result.errors.join('\n')}`); process.exit(1); }
  writeFileSync(`${root}/programs/${name}.COM`, result.com!);
  console.log(`${name}.COM: ${result.com!.length} bytes`);
}
