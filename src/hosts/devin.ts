import path from 'node:path';
import { S } from '../ui/strings.js';
import {
  defaultProbe,
  detectHost,
  hostHome,
  rollbackHostPlan,
  type HostAdapter,
  type HostProbe,
} from './types.js';

// ---------------------------------------------------------------------------
// Devin — §2.5.
// Detecção: `devin --version` + ~/.devin/, ~/.config/devin/
// Auth: sem probe documentado ⇒ 'unknown' (teto 'configured').
// Integração: nenhuma superfície MCP documentada encontrada ⇒ planIntegration
// retorna null — honesto hostUnsupported, nunca registro inventado.
// ---------------------------------------------------------------------------

const CONFIG_REL = ['.devin', path.join('.config', 'devin')];

export function createDevinAdapter(probe: HostProbe = defaultProbe): HostAdapter {
  return {
    id: 'devin',
    displayName: 'Devin',
    detect: (home) => {
      const h = hostHome(home);
      return detectHost(h, {
        id: 'devin',
        probe,
        versionArgv: [['devin', '--version']],
        configRel: CONFIG_REL,
      });
    },
    // Nenhuma superfície de integração documentada ⇒ null (hostUnsupported).
    planIntegration: async () => null,
    applyIntegration: async () => ({
      ok: false,
      applied: [],
      skipped: [],
      detail: S.hostUnsupported,
    }),
    validateIntegration: async () => ({
      ok: false,
      checks: [{ id: 'integration-surface', result: 'skipped', detail: S.hostUnsupported }],
    }),
    rollback: (plan, backup, home) => rollbackHostPlan(hostHome(home), plan, backup),
  };
}

export const devinAdapter = createDevinAdapter();
