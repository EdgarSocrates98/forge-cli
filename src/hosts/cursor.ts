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
// Cursor — §2.5.
// Detecção: `cursor --version` + ~/.cursor/, ~/.cursor/mcp.json
// Auth: sem probe documentado ⇒ 'unknown' (teto 'configured').
// Integração: merge-json em ~/.cursor/mcp.json → mcpServers[forge_id].
// Não há comando de registro MCP documentado no CLI do cursor ⇒ sem
// copyable_command; o preview do merge-json é a alternativa manual honesta.
// ---------------------------------------------------------------------------

const CONFIG_FILE = path.join('.cursor', 'mcp.json');
const CONFIG_REL = [CONFIG_FILE, '.cursor'];

function targetFor(home: string): string {
  return path.join(home, CONFIG_FILE);
}

export function createCursorAdapter(probe: HostProbe = defaultProbe): HostAdapter {
  return {
    id: 'cursor',
    displayName: 'Cursor',
    detect: (home) => {
      const h = hostHome(home);
      return detectHost(h, {
        id: 'cursor',
        probe,
        versionArgv: [['cursor', '--version']],
        configRel: CONFIG_REL,
        hasIntegration: (dir) => hasAnyMcpEntry(targetFor(dir)),
      });
    },
    planIntegration: async (forge, _workspaceDir, home) => {
      const argv = forge.mcp_command;
      if (!argv?.length) return null;
      const h = hostHome(home);
      const target = targetFor(h);
      if (hasMcpEntry(target, forge.forge_id)) {
        return {
          host: 'cursor',
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
        host: 'cursor',
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

export const cursorAdapter = createCursorAdapter();
