// Morre ao receber o primeiro request — exercita 'server-exit' + stderr no detail.
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', () => {
  process.stderr.write('panic: fixture crash\n');
  process.exit(42);
});
setTimeout(() => process.exit(42), 5000).unref();
