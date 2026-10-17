// Escreve texto puro no stdout — exercita 'stdout-non-json'.
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', () => {
  process.stdout.write('READY but not json\n');
});
