import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Níveis de verificação MCP — honestos, cumulativos. */
export type McpLevel = 'EXECUTABLE' | 'MCP_INITIALIZED' | 'TOOLS_DISCOVERED';

export interface McpProbeResult {
  ok: boolean;
  levels: McpLevel[];
  tools: number | null;
  serverInfo: { name?: string; version?: string } | null;
  protocolVersion: string | null;
  error: { code: string; detail: string } | null;
}

const PROTOCOL_VERSION = '2024-11-05';
const STEP_MS = 8_000;
const MAX_LINE = 1 << 20; // 1 MiB por mensagem JSON-RPC
const MAX_LINES = 64;

const err = (code: string, detail: string): McpProbeResult => ({
  ok: false,
  levels: [],
  tools: null,
  serverInfo: null,
  protocolVersion: null,
  error: { code, detail: detail.slice(0, 300) },
});

/**
 * Handshake MCP stdio real: spawn(argv) → initialize → notifications/initialized →
 * tools/list → kill. Nenhuma tool é invocada (tools/call fica fora por segurança).
 * Sem shell interpolation — argv array direto no spawn.
 */
export function probeMcpServer(argv: string[]): Promise<McpProbeResult> {
  return new Promise((resolve) => {
    if (!argv.length || !argv[0]) {
      resolve(err('argv-empty', 'comando MCP vazio'));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    } catch (e) {
      resolve(err('spawn-failed', e instanceof Error ? e.message : String(e)));
      return;
    }
    const levels: McpLevel[] = [];
    let tools: number | null = null;
    let serverInfo: McpProbeResult['serverInfo'] = null;
    let protocolVersion: string | null = null;
    let stdoutGarbage = false;
    let done = false;

    const finish = (r: McpProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(r);
    };
    const timer = setTimeout(() => {
      finish({
        ...err('timeout', `sem resposta em ${STEP_MS}ms (níveis: ${levels.join(',') || 'nenhum'})`),
        levels,
      });
    }, STEP_MS);

    const pending = new Map<number, (msg: Record<string, unknown>) => void>();
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    let lines = 0;
    rl.on('line', (line) => {
      if (line.length > MAX_LINE || ++lines > MAX_LINES) {
        stdoutGarbage = true;
        finish({
          ...err('stdout-oversized', 'saída stdout excedeu limites — não é um MCP stdio limpo'),
          levels,
        });
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        stdoutGarbage = true;
        finish({
          ...err('stdout-non-json', 'server escreveu não-JSON no stdout (logs indevidos?)'),
          levels,
        });
        return;
      }
      const id = msg.id;
      if (typeof id === 'number' && pending.has(id)) {
        pending.get(id)!(msg);
        pending.delete(id);
      }
    });
    child.on('error', (e) => finish({ ...err('spawn-failed', e.message), levels }));
    child.on('exit', (code) => {
      if (!done)
        finish({ ...err('server-exit', `exit ${code} antes do handshake completar`), levels });
    });
    const stderr: string[] = [];
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.join('').length < 4096) stderr.push(d.toString('utf8'));
    });

    const request = (method: string, params: Record<string, unknown>, id: number) =>
      new Promise<Record<string, unknown>>((ok, bad) => {
        pending.set(id, ok);
        const stepTimer = setTimeout(() => {
          pending.delete(id);
          bad(new Error(`${method}: timeout por etapa`));
        }, STEP_MS);
        setTimeout(() => clearTimeout(stepTimer), STEP_MS + 50);
        child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    const notify = (method: string) =>
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);

    void (async () => {
      try {
        const init = await request(
          'initialize',
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'forge-cli', version: '0.1.0' },
          },
          1,
        );
        const res = (init.result ?? {}) as Record<string, unknown>;
        if (init.error || typeof res !== 'object' || !res.protocolVersion) {
          finish(
            err(
              'initialize-invalid',
              `resposta initialize inválida: ${JSON.stringify(init).slice(0, 200)}`,
            ),
          );
          return;
        }
        protocolVersion = String(res.protocolVersion);
        const si = res.serverInfo as Record<string, unknown> | undefined;
        serverInfo = si ? { name: String(si.name ?? ''), version: String(si.version ?? '') } : null;
        levels.push('MCP_INITIALIZED');
        notify('notifications/initialized');

        const list = await request('tools/list', {}, 2);
        const tl = ((list.result ?? {}) as Record<string, unknown>).tools;
        if (list.error || !Array.isArray(tl)) {
          finish({
            ...err('tools-list-invalid', 'tools/list ausente ou malformado'),
            levels,
            protocolVersion,
            serverInfo,
          });
          return;
        }
        for (const t of tl as Array<Record<string, unknown>>) {
          if (typeof t.name !== 'string') {
            finish({
              ...err('tool-schema-invalid', 'tool sem name:string'),
              levels,
              protocolVersion,
              serverInfo,
            });
            return;
          }
        }
        tools = tl.length;
        levels.push('TOOLS_DISCOVERED');
        finish({ ok: !stdoutGarbage, levels, tools, serverInfo, protocolVersion, error: null });
      } catch (e) {
        finish({ ...err('handshake-failed', e instanceof Error ? e.message : String(e)), levels });
      }
    })();
  });
}
