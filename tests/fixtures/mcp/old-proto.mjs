// Negocia protocolVersion diferente → PROTOCOL_MISMATCH.
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2020-01-01',
          capabilities: {},
          serverInfo: { name: 'old', version: '0' },
        },
      })}\n`,
    );
  }
});
