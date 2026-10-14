import path from 'node:path';
import { S } from '../ui/strings.js';
import {
  applyHostPlan,
  defaultProbe,
  detectHost,
  hasAnyMcpEntry,
  hasMcpEntry,
  hostHome,
  mergedMcpConfig,
  readJsonObject,
  rollbackHostPlan,
  validateMcpFile,
  type HostAdapter,
  type HostPlan,
  type HostProbe,
} from './types.js';

// ---------------------------------------------------------------------------
// Claude Code — §2.5.
// Detecção: `claude --version` + ~/.claude.json, ~/.claude/, ~/.claude/settings.json
// Auth: não há probe de auth-status documentado ⇒ auth fica 'unknown' e o
// estado nunca passa de 'configured' (a menos que integração seja evidenciada).
// Integração: merge-json em ~/.claude.json → mcpServers[forge_id].
// Alternativa manual documentada: `claude mcp add <nome> --scope user -- <argv>`.
// ---------------------------------------------------------------------------

const CONFIG_FILE = '.claude.json';
const CONFIG_REL = [CONFIG_FILE, '.claude', path.join('.claude', 'settings.json')];

function targetFor(home: string): string {
  return path.join(home, CONFIG_FILE);
}

export function createClaudeAdapter(probe: HostProbe = defaultProbe): HostAdapter {
  return {
    id: 'claude',
    displayName: 'Claude Code',
    detect: (home) => {
      const h = hostHome(home);
      return detectHost(h, {
        id: 'claude',
        probe,
        versionArgv: [['claude', '--version']],
        configRel: CONFIG_REL,
        // authArgv ausente de propósito: sem comando documentado, nunca inferimos.
        hasIntegration: (dir) => hasAnyMcpEntry(targetFor(dir)),
      });
    },
    planIntegration: async (forge, _workspaceDir, home) => {
      const argv = forge.mcp_command;
      if (!argv?.length) return null; // sem descritor mcp_command não há registro honesto
      const h = hostHome(home);
      const target = targetFor(h);
      if (hasMcpEntry(target, forge.forge_id)) {
        return {
          host: 'claude',
          forge_id: forge.forge_id,
          actions: [{ kind: 'manual', reason: S.hostAlreadyIntegrated }],
          reversible: true,
        };
      }
      const existing = readJsonObject(target);
      const fragment = {
        mcpServers: { [forge.forge_id]: { command: argv[0], args: argv.slice(1) } },
      };
      const plan: HostPlan = {
        host: 'claude',
        forge_id: forge.forge_id,
        actions: [
          {
            kind: 'merge-json',
            target,
            argv,
            preview: JSON.stringify(fragment, null, 2),
            reason: existing === 'invalid' ? 'target-json-invalid' : 'mcpServers',
          },
        ],
        copyable_command: `claude mcp add ${forge.forge_id} --scope user -- ${argv.join(' ')}`,
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
          const merged = mergedMcpConfig(readJsonObject(action.target), plan.forge_id, action.argv);
          return typeof merged === 'object'
            ? { target: action.target, content: merged.content }
            : merged;
        },
        opts,
      ),
    validateIntegration: async (forge_id, home) =>
      validateMcpFile(targetFor(hostHome(home)), forge_id),
    rollback: (plan, backup, home) => rollbackHostPlan(hostHome(home), plan, backup),
  };
}

export const claudeAdapter = createClaudeAdapter();
