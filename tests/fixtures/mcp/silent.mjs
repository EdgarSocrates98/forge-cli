// Nunca responde — exercita o timeout do probe.
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', () => {});
setInterval(() => {}, 1000);
