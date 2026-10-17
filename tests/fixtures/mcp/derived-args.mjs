// Tool allowlisted com campos required de tipos simples → verify deriva
// input mínimo (string→"", number→0, boolean→false) e chama.
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
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'derived', version: '0' },
        },
      })}\n`,
    );
  } else if (msg.method === 'tools/list') {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'safe_ping',
              inputSchema: {
                type: 'object',
                required: ['label', 'count', 'verbose'],
                properties: {
                  label: { type: 'string' },
                  count: { type: 'integer' },
                  verbose: { type: 'boolean' },
                },
              },
            },
          ],
        },
      })}\n`,
    );
  } else if (msg.method === 'tools/call') {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: 'ok' }] },
      })}\n`,
    );
  }
});
