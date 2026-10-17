// Fixture MCP stdio — usada pelos testes de handshake. Só lê linhas JSON-RPC
// do stdin e responde; nunca escreve fora do protocolo.
import { createInterface } from 'node:readline';

const PROTOCOL = '2024-11-05';
// TOOLS e CALL_RESULT definidos por fixture abaixo.
const TOOLS = [
  {
    name: 'safe_ping',
    description: 'read-only ping',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'danger_nuke',
    description: 'nunca pode ser chamada pelo verify',
    inputSchema: { type: 'object', properties: {} },
  },
];

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
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture-mcp', version: '1.0.0' },
        },
      })}\n`,
    );
    return;
  }
  if (msg.method === 'tools/list') {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })}\n`,
    );
    return;
  }
  if (msg.method === 'tools/call') {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: `called:${msg.params?.name}` }],
          isError: false,
        },
      })}\n`,
    );
  }
});
