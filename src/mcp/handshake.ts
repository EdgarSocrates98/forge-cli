import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { redactSecrets } from '../safety.js';
import { CLI_VERSION } from '../version.js';

/**
 * Níveis de verificação MCP — honestos, cumulativos e nesta ordem.
 * HOST_VERIFIED não é atingido pelo probe: a camada de comando o acrescenta
 * quando a config de algum host referencia o server (detectAll/validate).
 */
export type McpLevel =
  | 'INSTALLED'
  | 'EXECUTABLE'
  | 'INITIALIZED'
  | 'TOOLS_DISCOVERED'
  | 'SAFE_TOOL_CALLED'
  | 'HOST_VERIFIED';

export interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpProbeResult {
  ok: boolean;
  levels: McpLevel[];
  tools: number | null;
  serverInfo: { name?: string; version?: string } | null;
  protocolVersion: string | null;
  /** Tool da allowlist efetivamente invocada (null quando nenhuma chamada). */
  calledTool: McpToolCall | null;
  /**
   * Nota honesta quando a verificação para antes de SAFE_TOOL_CALLED sem
   * falha do server: 'no-allowlisted-tool' | 'allowlisted-tool-not-advertised'
   * | 'tool-input-underivable[:campo]'.
   */
  detail: string | null;
  error: { code: string; detail: string } | null;
}

const PROTOCOL_VERSION = '2024-11-05';
const STEP_MS = 8_000;
const MAX_LINE = 1 << 20; // 1 MiB por mensagem JSON-RPC
const MAX_LINES = 64;
const MAX_TOTAL_BYTES = 4 << 20; // 4 MiB acumulados no stdout inteiro
const MAX_STDERR_CHARS = 4096;
const MAX_STDERR_DETAIL = 240;
const KILL_GRACE_MS = 750;

const err = (code: string, detail: string): McpProbeResult => ({
  ok: false,
  levels: [],
  tools: null,
  serverInfo: null,
  protocolVersion: null,
  calledTool: null,
  detail: null,
  // stderr/msgs remotas podem ecoar env — sempre sanitizado e truncado.
  error: { code, detail: redactSecrets(detail).slice(0, 300) },
});

const okResult = (levels: McpLevel[], extras: Partial<McpProbeResult> = {}): McpProbeResult => ({
  ok: true,
  levels,
  tools: null,
  serverInfo: null,
  protocolVersion: null,
  calledTool: null,
  detail: null,
  error: null,
  ...extras,
});

const UNDERIVABLE = { ok: false as const };

/**
 * Default seguro para UM campo requerido de um JSON Schema: `default`,
 * `const`, primeiro `enum`, ou o valor neutro do tipo declarado
 * (string→"", number/integer→0, boolean→false). Qualquer outra coisa —
 * array, object, anyOf, tipo ausente — é UNDERIVABLE: nunca inventamos
 * estrutura para satisfazer um campo requerido.
 */
function safeValueFor(spec: unknown): { ok: true; value: unknown } | typeof UNDERIVABLE {
  if (spec === undefined || spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return UNDERIVABLE;
  }
  const s = spec as Record<string, unknown>;
  if ('default' in s) return { ok: true, value: s.default };
  if ('const' in s) return { ok: true, value: s.const };
  if (Array.isArray(s.enum) && s.enum.length > 0) return { ok: true, value: s.enum[0] };
  const t = Array.isArray(s.type) ? (s.type.find((x) => x !== 'null') ?? s.type[0]) : s.type;
  switch (t) {
    case 'string':
      return { ok: true, value: '' };
    case 'number':
    case 'integer':
      return { ok: true, value: 0 };
    case 'boolean':
      return { ok: true, value: false };
    default:
      return UNDERIVABLE;
  }
}

export type ToolInputDerivation =
  | { kind: 'ok'; args: Record<string, unknown> }
  | { kind: 'invalid-schema' }
  | { kind: 'underivable'; field: string };

/**
 * Deriva o input mínimo válido de uma tool a partir do inputSchema anunciado:
 * só campos em `required`, cada um com seu default seguro. Schema ausente →
 * arguments {}. Schema malformado → 'invalid-schema'. Campo requerido sem
 * default derivável → 'underivable' (o chamador reporta e NÃO chama).
 */
export function deriveMinimalInput(inputSchema: unknown): ToolInputDerivation {
  if (inputSchema === undefined || inputSchema === null) return { kind: 'ok', args: {} };
  if (typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return { kind: 'invalid-schema' };
  }
  const schema = inputSchema as Record<string, unknown>;
  const props = schema.properties;
  if (
    props !== undefined &&
    (typeof props !== 'object' || props === null || Array.isArray(props))
  ) {
    return { kind: 'invalid-schema' };
  }
  const required = schema.required;
  if (
    required !== undefined &&
    (!Array.isArray(required) || !required.every((r) => typeof r === 'string'))
  ) {
    return { kind: 'invalid-schema' };
  }
  const args: Record<string, unknown> = {};
  const propMap = props as Record<string, unknown> | undefined;
  for (const name of (required as string[] | undefined) ?? []) {
    const v = safeValueFor(propMap?.[name]);
    if (!v.ok) return { kind: 'underivable', field: name };
    args[name] = v.value;
  }
  return { kind: 'ok', args };
}

export interface ProbeOptions {
  /**
   * Allowlist explícita de tools chamáveis (vem do catálogo registry —
   * `mcp_safe_tools`). Vazia/ausente → a verificação para em TOOLS_DISCOVERED.
   * A segurança NUNCA é inferida do nome da tool (list/get/read não bastam).
   */
  safeTools?: readonly string[];
  /** Timeout global e por etapa (default 8000ms) — injetável em testes. */
  timeoutMs?: number;
}

function sanitizeStderr(stderr: string[]): string {
  const tail = stderr.join('').slice(-MAX_STDERR_CHARS);
  return redactSecrets(tail).slice(-MAX_STDERR_DETAIL);
}

/**
 * Handshake MCP stdio real: argv[0] no disco → spawn (argv array, sem shell)
 * → initialize → notifications/initialized → tools/list → tools/call de UMA
 * tool da allowlist explícita → kill garantido em todos os caminhos.
 * tools/call só acontece com input mínimo derivável do inputSchema anunciado.
 */
export function probeMcpServer(argv: string[], opts: ProbeOptions = {}): Promise<McpProbeResult> {
  return new Promise((resolve) => {
    if (!argv.length || !argv[0]) {
      resolve(err('argv-empty', 'comando MCP vazio'));
      return;
    }
    const stepMs = opts.timeoutMs ?? STEP_MS;
    const levels: McpLevel[] = [];
    // INSTALLED: binário absoluto precisa existir no disco antes do spawn;
    // nome relativo é provado pelo evento 'spawn' (PATH resolveu).
    if (path.isAbsolute(argv[0])) {
      if (!existsSync(argv[0])) {
        resolve(err('bin-missing', `binário MCP ausente: ${argv[0]}`));
        return;
      }
      levels.push('INSTALLED');
    }
    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    } catch (e) {
      resolve(err('spawn-failed', e instanceof Error ? e.message : String(e)));
      return;
    }
    let tools: number | null = null;
    let serverInfo: McpProbeResult['serverInfo'] = null;
    let protocolVersion: string | null = null;
    let calledTool: McpToolCall | null = null;
    let done = false;
    let killer: NodeJS.Timeout | undefined;

    const finish = (r: McpProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Kill garantido em TODOS os caminhos: SIGTERM agora, SIGKILL se o
      // processo ignorar. Nenhum caminho (erro, exit, timeout, oversize)
      // deixa o filho vivo.
      try {
        child.kill('SIGTERM');
      } catch {
        // processo já morto — nada a fazer
      }
      killer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // já saiu
        }
      }, KILL_GRACE_MS);
      killer.unref();
      child.stdin?.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => {
      finish({
        ...err('timeout', `sem resposta em ${stepMs}ms (níveis: ${levels.join(',') || 'nenhum'})`),
        levels,
      });
    }, stepMs);

    const pending = new Map<number, (msg: Record<string, unknown>) => void>();
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    let lines = 0;
    let totalBytes = 0;
    rl.on('line', (line) => {
      totalBytes += line.length + 1;
      if (line.length > MAX_LINE || ++lines > MAX_LINES || totalBytes > MAX_TOTAL_BYTES) {
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
    child.on('spawn', () => {
      if (!levels.includes('INSTALLED')) levels.push('INSTALLED');
      levels.push('EXECUTABLE');
    });
    child.on('error', (e) => finish({ ...err('spawn-failed', e.message), levels }));
    const stderr: string[] = [];
    let stderrChars = 0;
    child.stderr?.on('data', (d: Buffer) => {
      if (stderrChars < MAX_STDERR_CHARS) {
        stderr.push(d.toString('utf8'));
        stderrChars += d.length;
      }
    });
    child.on('exit', (code) => {
      if (done) return;
      const tail = sanitizeStderr(stderr);
      finish({
        ...err(
          'server-exit',
          `exit ${code} antes do handshake completar${tail ? ` — stderr: ${tail}` : ''}`,
        ),
        levels,
      });
    });

    const send = (frame: Record<string, unknown>): void => {
      try {
        child.stdin!.write(`${JSON.stringify(frame)}\n`);
      } catch {
        /* EPIPE: child já morreu — o handler 'exit' produz o erro nomeado */
      }
    };
    const request = (method: string, params: Record<string, unknown>, id: number) =>
      new Promise<Record<string, unknown>>((ok, bad) => {
        pending.set(id, ok);
        const stepTimer = setTimeout(() => {
          pending.delete(id);
          bad(new Error(`${method}: timeout por etapa`));
        }, stepMs);
        stepTimer.unref();
        send({ jsonrpc: '2.0', id, method, params });
      });
    const notify = (method: string) => send({ jsonrpc: '2.0', method });

    const fail = (code: string, detail: string) =>
      finish({ ...err(code, detail), levels, protocolVersion, serverInfo, tools, calledTool });

    void (async () => {
      try {
        const init = await request(
          'initialize',
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'forge-cli', version: CLI_VERSION },
          },
          1,
        );
        if (init.jsonrpc !== '2.0') {
          fail('PROTOCOL_MISMATCH', 'resposta initialize sem jsonrpc "2.0"');
          return;
        }
        const res = (init.result ?? {}) as Record<string, unknown>;
        if (init.error || typeof res !== 'object' || res === null) {
          fail(
            'initialize-invalid',
            `resposta initialize inválida: ${JSON.stringify(init).slice(0, 200)}`,
          );
          return;
        }
        if (typeof res.protocolVersion !== 'string' || !res.protocolVersion) {
          fail('initialize-invalid', 'initialize sem protocolVersion:string');
          return;
        }
        protocolVersion = res.protocolVersion;
        const si = res.serverInfo as Record<string, unknown> | undefined;
        serverInfo = si ? { name: String(si.name ?? ''), version: String(si.version ?? '') } : null;
        levels.push('INITIALIZED');
        if (res.protocolVersion !== PROTOCOL_VERSION) {
          fail(
            'PROTOCOL_MISMATCH',
            `server negociou ${res.protocolVersion}; forge-cli fala ${PROTOCOL_VERSION}`,
          );
          return;
        }
        notify('notifications/initialized');

        const list = await request('tools/list', {}, 2);
        if (list.jsonrpc !== '2.0') {
          fail('PROTOCOL_MISMATCH', 'resposta tools/list sem jsonrpc "2.0"');
          return;
        }
        const tl = ((list.result ?? {}) as Record<string, unknown>).tools;
        if (list.error || !Array.isArray(tl)) {
          fail('tools-list-invalid', 'tools/list ausente ou malformado');
          return;
        }
        const toolsList = tl as Array<Record<string, unknown>>;
        for (const t of toolsList) {
          if (!t || typeof t !== 'object' || typeof t.name !== 'string') {
            fail('INVALID_SCHEMA', 'tool sem name:string no tools/list');
            return;
          }
        }
        tools = toolsList.length;
        levels.push('TOOLS_DISCOVERED');

        // ---- tools/call: UMA tool, SÓ se explicitamente allowlisted --------
        const allow = opts.safeTools ?? [];
        if (!allow.length) {
          finish(
            okResult(levels, {
              tools,
              serverInfo,
              protocolVersion,
              detail: 'no-allowlisted-tool',
            }),
          );
          return;
        }
        const picked = allow.find((name) => toolsList.some((t) => t.name === name));
        if (!picked) {
          finish(
            okResult(levels, {
              tools,
              serverInfo,
              protocolVersion,
              detail: 'allowlisted-tool-not-advertised',
            }),
          );
          return;
        }
        const tool = toolsList.find((t) => t.name === picked)!;
        const derived = deriveMinimalInput(tool.inputSchema);
        if (derived.kind === 'invalid-schema') {
          fail('INVALID_SCHEMA', `inputSchema de "${picked}" fora do formato esperado`);
          return;
        }
        if (derived.kind === 'underivable') {
          finish(
            okResult(levels, {
              tools,
              serverInfo,
              protocolVersion,
              detail: `tool-input-underivable:${derived.field}`,
            }),
          );
          return;
        }
        const call = await request('tools/call', { name: picked, arguments: derived.args }, 3);
        calledTool = { name: picked, arguments: derived.args };
        if (call.jsonrpc !== '2.0') {
          fail('PROTOCOL_MISMATCH', 'resposta tools/call sem jsonrpc "2.0"');
          return;
        }
        if (call.error) {
          const e = call.error as Record<string, unknown>;
          fail(
            'TOOL_CALL_ERROR',
            `${picked}: ${typeof e.message === 'string' ? e.message : JSON.stringify(e).slice(0, 200)}`,
          );
          return;
        }
        const callRes = call.result as Record<string, unknown> | undefined;
        if (!callRes || typeof callRes !== 'object') {
          fail('PROTOCOL_MISMATCH', 'tools/call sem result');
          return;
        }
        // isError:true no result é erro de execução reportado pela própria tool.
        if (callRes.isError === true) {
          fail('TOOL_CALL_ERROR', `${picked}: tool reportou isError no result`);
          return;
        }
        levels.push('SAFE_TOOL_CALLED');
        finish(okResult(levels, { tools, serverInfo, protocolVersion, calledTool }));
      } catch (e) {
        finish({
          ...err('handshake-failed', e instanceof Error ? e.message : String(e)),
          levels,
          protocolVersion,
          serverInfo,
          tools,
          calledTool,
        });
      }
    })();
  });
}
