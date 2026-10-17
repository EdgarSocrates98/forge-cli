// tools/call responde com erro JSON-RPC → TOOL_CALL_ERROR.
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
          serverInfo: { name: 'err', version: '0' },
        },
      })}\n`,
    );
  } else if (msg.method === 'tools/list') {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [{ name: 'safe_ping', inputSchema: { type: 'object' } }],
        },
      })}\n`,
    );
  } else if (msg.method === 'tools/call') {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: 'internal tool failure' },
      })}\n`,
    );
  }
});
