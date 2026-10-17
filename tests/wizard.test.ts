import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPlan,
  SELECTABLE_STEPS,
  type PlanForge,
  type SelectableStep,
} from '../src/planner.js';
import type { ForgeRepo } from '../src/types.js';
import { planActionsFor, renderOperationPlan } from '../src/wizard.js';

// ---------------------------------------------------------------------------
// §2.3/§2.6 — superfícies determinísticas do wizard: renderização do plano
// revisado e construção das ações por repositório. O fluxo interativo
// (@clack/prompts) é fronteira de TUI e não é simulado aqui.
// ---------------------------------------------------------------------------

const REPO: ForgeRepo = {
  name: 'api-forge',
  url: 'https://example.invalid/api-forge.git',
  description: 'forge de teste',
  kind: 'python',
  verify: ['pytest -q'],
  nativeInstall: { command: ['apiforge', 'install'], flags: ['scope'] },
};

const REPO_NO_VERIFY: ForgeRepo = { ...REPO, name: 'x-forge', verify: undefined };

let targetDir: string;
beforeEach(() => {
  targetDir = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-wizard-'));
});
afterEach(() => {
  rmSync(targetDir, { recursive: true, force: true });
});

function makeGitClone(name: string): void {
  mkdirSync(path.join(targetDir, name, '.git'), { recursive: true });
}

describe('planActionsFor — detecção clone vs pull', () => {
  const steps: SelectableStep[] = ['clone'];

  it('sem diretório do repo ⇒ git clone com argv completo', () => {
    const actions = planActionsFor(REPO, targetDir, steps);
    const clone = actions.find((a) => a.kind === 'clone')!;
    expect(clone.label).toBe('git clone api-forge');
    expect(clone.argv).toEqual(['git', 'clone', REPO.url, path.join(targetDir, REPO.name)]);
    expect(clone.reversible).toBe(true);
  });

  it('diretório existente sem .git ⇒ ainda git clone (não é clone gerenciado)', () => {
    mkdirSync(path.join(targetDir, REPO.name), { recursive: true });
    const clone = planActionsFor(REPO, targetDir, steps).find((a) => a.kind === 'clone')!;
    expect(clone.label).toBe('git clone api-forge');
  });

  it('.git presente ⇒ git pull --ff-only no diretório do repo', () => {
    makeGitClone(REPO.name);
    const clone = planActionsFor(REPO, targetDir, steps).find((a) => a.kind === 'clone')!;
    expect(clone.label).toBe('git pull --ff-only (api-forge)');
    expect(clone.argv).toEqual(['git', '-C', path.join(targetDir, REPO.name), 'pull', '--ff-only']);
  });
});

describe('planActionsFor — gating por passo selecionável', () => {
  it('somente clone ⇒ sem binary/skills/agents/mcp/host-integration', () => {
    const kinds = planActionsFor(REPO, targetDir, ['clone']).map((a) => a.kind);
    expect(kinds).toEqual(['clone', 'env', 'verify']);
    expect(kinds).not.toContain('binary');
    expect(kinds).not.toContain('skills');
    expect(kinds).not.toContain('host-integration');
  });

  it('cada passo selecionável adiciona sua ação correspondente', () => {
    const all = [...SELECTABLE_STEPS];
    const kinds = planActionsFor(REPO, targetDir, all).map((a) => a.kind);
    for (const s of all) expect(kinds).toContain(s);
    expect(kinds).toContain('env');
    expect(kinds).toContain('verify');
  });

  it('binary declara efeito não-reversível documentado', () => {
    const bin = planActionsFor(REPO, targetDir, ['clone', 'binary']).find(
      (a) => a.kind === 'binary',
    )!;
    expect(bin.non_reversible_effects?.length).toBeGreaterThan(0);
  });

  it('host-integration declara efeito fora do workspace', () => {
    const hi = planActionsFor(REPO, targetDir, ['clone', 'host-integration']).find(
      (a) => a.kind === 'host-integration',
    )!;
    expect(hi.reversible).toBe(false);
    expect(hi.non_reversible_effects?.join(' ')).toContain('fora do workspace');
  });
});

describe('planActionsFor — ações sempre presentes', () => {
  it('env sempre entra, não-reversível, apontando para <repo>/.env', () => {
    const env = planActionsFor(REPO, targetDir, ['clone']).find((a) => a.kind === 'env')!;
    expect(env.reversible).toBe(false);
    expect(env.paths).toEqual([path.join(REPO.name, '.env')]);
  });

  it('verify usa repo.verify quando declarado', () => {
    const verify = planActionsFor(REPO, targetDir, ['clone']).find((a) => a.kind === 'verify')!;
    expect(verify.label).toBe('verificar: pytest -q');
    expect(verify.reversible).toBe(true);
  });

  it('verify honesto quando não há verificação declarada', () => {
    const verify = planActionsFor(REPO_NO_VERIFY, targetDir, ['clone']).find(
      (a) => a.kind === 'verify',
    )!;
    expect(verify.label).toBe('sem verificação declarada');
  });
});

describe('renderOperationPlan — superfície de revisão', () => {
  function planWith(actions: PlanForge['actions'], steps?: SelectableStep[]) {
    const forge: PlanForge = {
      forge_id: 'api-forge',
      repo: 'api-forge',
      target_dir: path.join(targetDir, 'api-forge'),
      actions,
    };
    return buildPlan({ source: 'wizard', forges: [forge], selected_steps: steps });
  }

  it('mostra hash truncado, expiração e passos selecionados', () => {
    const plan = planWith([], ['clone', 'skills']);
    const text = renderOperationPlan(plan);
    expect(text).toContain(plan.hash.slice(0, 16));
    expect(text).toContain('…');
    expect(text).toContain(plan.expires_at);
    expect(text).toContain('clone, skills');
  });

  it('omite a linha de passos quando não há selected_steps', () => {
    const text = renderOperationPlan(planWith([]));
    expect(text).not.toContain('Passos selecionados');
  });

  it('marca ações não-reversíveis com a nota de escopo de rollback', () => {
    const plan = planWith([
      { kind: 'env', label: 'provisionar .env', reversible: false },
      { kind: 'clone', label: 'git clone x', reversible: true },
    ]);
    const text = renderOperationPlan(plan);
    const envLine = text.split('\n').find((l) => l.includes('provisionar .env'))!;
    const cloneLine = text.split('\n').find((l) => l.includes('git clone x'))!;
    expect(envLine).toContain('Rollback cobre apenas efeitos reversíveis documentados');
    expect(cloneLine).not.toContain('Rollback cobre');
  });

  it('lista arquivos previstos (paths das ações) e trunca em 8', () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
    const plan = planWith([{ kind: 'env', label: 'env', paths: files, reversible: false }]);
    const filesLine = renderOperationPlan(plan)
      .split('\n')
      .find((l) => l.includes('arquivos:'))!;
    // predictedChanges ordena; só os 8 primeiros aparecem.
    for (const f of files.slice(0, 8)) expect(filesLine).toContain(f);
    expect(filesLine).not.toContain(files[9]);
  });

  it('plano sem ações renderiza apenas o cabeçalho + nome da forja', () => {
    const text = renderOperationPlan(planWith([]));
    expect(text).toContain('api-forge');
    expect(text.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(3);
  });
});
