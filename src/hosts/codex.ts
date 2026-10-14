import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { S } from '../ui/strings.js';
import {
  applyHostPlan,
  defaultProbe,
  detectHost,
  hostHome,
  rollbackHostPlan,
  type HostAdapter,
  type HostPlan,
  type HostProbe,
  type HostValidation,
} from './types.js';

// ---------------------------------------------------------------------------
// Codex — §2.5.
// Detecção: `codex --version` + ~/.codex/, ~/.codex/config.toml
// Auth: `codex login status` é documentado ⇒ sai 0 ⇒ 'verified'; falha ⇒
// 'absent' (nunca inferimos autenticação por presença de config).
// Integração: [mcp_servers."<forge_id>"] em ~/.codex/config.toml via
// text-append. Merge TOML é propositalmente simplista: só detecção de seção
// duplicada + append ao final — nunca reescreve nem reordena o arquivo.
// Alternativa manual documentada: `codex mcp add <nome> -- <argv>`.
// ---------------------------------------------------------------------------

const CONFIG_FILE = path.join('.codex', 'config.toml');
const CONFIG_REL = [CONFIG_FILE, '.codex'];

function targetFor(home: string): string {
  return path.join(home, CONFIG_FILE);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** true quando a config já declara a seção do servidor (qualquer forma TOML). */
export function hasCodexMcpSection(content: string, forgeId: string): boolean {
  const esc = escapeRe(forgeId);
  const bare = /^[A-Za-z0-9_-]+$/.test(forgeId) ? `|${esc}` : '';
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\.(?:"${esc}"${bare})\\s*\\]\\s*$`, 'm');
  if (header.test(content)) return true;
  // sub-chave dentro de uma tabela [mcp_servers] simples
  const key = new RegExp(`^\\s*(?:"${esc}"${bare})\\s*=`);
  let inServers = false;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (/^\[/.test(t)) {
      inServers = /^\[mcp_servers\]\s*$/.test(t);
      continue;
    }
    if (inServers && key.test(t)) return true;
  }
  return false;
}

export function hasAnyCodexMcpSection(content: string): boolean {
  return /^\s*\[\s*mcp_servers\./m.test(content);
}

/** Bloco TOML do servidor. Aspas via JSON.stringify produzem basic strings válidas. */
export function codexTomlBlock(forgeId: string, argv: readonly string[]): string {
  const q = (s: string) => JSON.stringify(s);
  return [
    `[mcp_servers.${q(forgeId)}]`,
    `command = ${q(argv[0])}`,
    `args = [${argv.slice(1).map(q).join(', ')}]`,
  ].join('\n');
}

/** command do servidor dentro da seção (simplista: 1ª linha `command = "..."` após o header). */
function codexSectionCommand(content: string, forgeId: string): string | null {
  const esc = escapeRe(forgeId);
  const bare = /^[A-Za-z0-9_-]+$/.test(forgeId) ? `|${esc}` : '';
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\.(?:"${esc}"${bare})\\s*\\]\\s*$`);
  let inside = false;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (/^\[/.test(t)) {
      if (inside) break;
      inside = header.test(t);
      continue;
    }
    if (inside) {
      const m = /^command\s*=\s*"([^"]*)"/.exec(t);
      if (m) return m[1];
    }
  }
  return null;
}

export function createCodexAdapter(probe: HostProbe = defaultProbe): HostAdapter {
  return {
    id: 'codex',
    displayName: 'Codex',
    detect: (home) => {
      const h = hostHome(home);
      return detectHost(h, {
        id: 'codex',
        probe,
        versionArgv: [['codex', '--version']],
        configRel: CONFIG_REL,
        authArgv: ['codex', 'login', 'status'],
        hasIntegration: (dir) => {
          const file = targetFor(dir);
          return existsSync(file) && hasAnyCodexMcpSection(readFileSync(file, 'utf8'));
        },
      });
    },
    planIntegration: async (forge, _workspaceDir, home) => {
      const argv = forge.mcp_command;
      if (!argv?.length) return null;
      const h = hostHome(home);
      const target = targetFor(h);
      const existing = existsSync(target) ? readFileSync(target, 'utf8') : null;
      if (existing !== null && hasCodexMcpSection(existing, forge.forge_id)) {
        return {
          host: 'codex',
          forge_id: forge.forge_id,
          actions: [{ kind: 'manual', reason: S.hostAlreadyIntegrated }],
          reversible: true,
        };
      }
      const plan: HostPlan = {
        host: 'codex',
        forge_id: forge.forge_id,
        actions: [
          {
            kind: 'write-config',
            target,
            argv,
            preview: codexTomlBlock(forge.forge_id, argv),
            reason: '[mcp_servers] append',
          },
        ],
        copyable_command: `codex mcp add ${forge.forge_id} -- ${argv.join(' ')}`,
        reversible: true,
      };
      return plan;
    },
    applyIntegration: (plan, opts) =>
      applyHostPlan(
        hostHome(opts?.home),
        plan,
        (action) => {
          if (!action.target || !action.argv?.length) return 'skip';
          const existing = existsSync(action.target) ? readFileSync(action.target, 'utf8') : null;
          if (existing !== null && hasCodexMcpSection(existing, plan.forge_id)) {
            return 'duplicate';
          }
          const block = codexTomlBlock(plan.forge_id, action.argv);
          const content =
            existing === null || existing.trim() === ''
              ? `${block}\n`
              : `${existing.trimEnd()}\n\n${block}\n`;
          return { target: action.target, content };
        },
        opts,
      ),
    validateIntegration: async (forge_id, home) => {
      const file = targetFor(hostHome(home));
      const checks: HostValidation['checks'] = [];
      if (!existsSync(file)) {
        checks.push({ id: 'config-file', result: 'fail', detail: 'absent' });
        checks.push({ id: 'mcp-section', result: 'fail', detail: forge_id });
        return { ok: false, checks };
      }
      checks.push({ id: 'config-file', result: 'pass', detail: file });
      const content = readFileSync(file, 'utf8');
      if (!hasCodexMcpSection(content, forge_id)) {
        checks.push({ id: 'mcp-section', result: 'fail', detail: forge_id });
        return { ok: false, checks };
      }
      checks.push({ id: 'mcp-section', result: 'pass', detail: forge_id });
      const command = codexSectionCommand(content, forge_id);
      const ok = command !== null && command.trim().length > 0;
      checks.push({
        id: 'command',
        result: ok ? 'pass' : 'fail',
        detail: ok ? command : 'empty',
      });
      return { ok, checks };
    },
    rollback: (plan, backup, home) => rollbackHostPlan(hostHome(home), plan, backup),
  };
}

export const codexAdapter = createCodexAdapter();
