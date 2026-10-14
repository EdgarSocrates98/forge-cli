import path from 'node:path';
import { existsSync } from 'node:fs';
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
// GitHub Copilot — §2.5.
// Detecção: `copilot --version` ou `gh copilot --help` (extensão do gh) +
// ~/.copilot/, ~/.copilot/mcp-config.json, ~/.config/gh (config do gh CLI).
// Auth: sem probe de auth-status documentado para o host ⇒ 'unknown'.
// Integração: só há superfície quando ~/.copilot/mcp-config.json já existe
// (merge-json em mcpServers); caso contrário planIntegration ⇒ null —
// honesto hostUnsupported, nunca registro inventado.
// ---------------------------------------------------------------------------

const CONFIG_FILE = path.join('.copilot', 'mcp-config.json');
const CONFIG_REL = ['.copilot', CONFIG_FILE, path.join('.config', 'gh')];

function targetFor(home: string): string {
  return path.join(home, CONFIG_FILE);
}

export function createCopilotAdapter(probe: HostProbe = defaultProbe): HostAdapter {
  return {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    detect: (home) => {
      const h = hostHome(home);
      return detectHost(h, {
        id: 'copilot',
        probe,
        versionArgv: [
          ['copilot', '--version'],
          ['gh', 'copilot', '--help'],
        ],
        configRel: CONFIG_REL,
        hasIntegration: (dir) => hasAnyMcpEntry(targetFor(dir)),
      });
    },
    planIntegration: async (forge, _workspaceDir, home) => {
      const argv = forge.mcp_command;
      if (!argv?.length) return null;
      const h = hostHome(home);
      const target = targetFor(h);
      // Sem arquivo de configuração MCP existente não há superfície documentada.
      if (!existsSync(target)) return null;
      if (hasMcpEntry(target, forge.forge_id)) {
        return {
          host: 'copilot',
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
        host: 'copilot',
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

export const copilotAdapter = createCopilotAdapter();
