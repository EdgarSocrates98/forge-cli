#!/usr/bin/env node
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  spinner,
  text,
} from '@clack/prompts';
import figlet from 'figlet';
import pc from 'picocolors';
import { FORGE_REPOS } from './constants/repos.js';
import type { RepoResult } from './types.js';
import { ensureDir, processRepo, resolveTargetDir } from './utils/system.js';

function exitCancelled(): never {
  cancel('Operação cancelada pelo usuário.');
  process.exit(0);
}

function statusLabel(result: RepoResult): string {
  if (result.status === 'ok') return pc.green('[OK]');
  if (result.status === 'warning') return pc.yellow('[AVISO]');
  return pc.red('[ERRO]');
}

async function main(): Promise<void> {
  console.log(pc.cyan(figlet.textSync('FORGE CLI', { font: 'Standard' })));
  intro(pc.inverse(' forge-cli — instalador do ecossistema Forge '));

  const dirAnswer = await text({
    message: 'Onde os repositórios devem ser instalados?',
    placeholder: './forge-workspace',
    defaultValue: './forge-workspace',
  });
  if (isCancel(dirAnswer)) exitCancelled();

  const targetDir = resolveTargetDir(dirAnswer);
  await ensureDir(targetDir);

  const selected = await multiselect({
    message: 'Selecione os repositórios para instalar',
    options: FORGE_REPOS.map((repo) => ({
      value: repo.name,
      label: repo.name,
      hint: repo.description,
    })),
    initialValues: FORGE_REPOS.map((repo) => repo.name),
    required: true,
  });
  if (isCancel(selected)) exitCancelled();

  const repos = FORGE_REPOS.filter((repo) => selected.includes(repo.name));

  note(`Destino: ${pc.cyan(targetDir)}\nRepositórios: ${pc.cyan(String(repos.length))} de ${FORGE_REPOS.length}`, 'Resumo');
  const proceed = await confirm({ message: 'Confirmar e iniciar a instalação?' });
  if (isCancel(proceed) || !proceed) exitCancelled();

  const results: RepoResult[] = [];
  for (const repo of repos) {
    const s = spinner();
    s.start(`Processando ${pc.cyan(repo.name)}...`);
    const result = await processRepo(repo, targetDir);
    results.push(result);
    if (result.status === 'warning') {
      s.stop(`${pc.yellow('[AVISO]')} ${repo.name} — ${result.detail}`);
      log.warn(result.detail);
    } else {
      s.stop(`${statusLabel(result)} ${repo.name} — ${result.detail}`);
    }
  }

  const ok = results.filter((r) => r.status === 'ok').length;
  const warnings = results.filter((r) => r.status === 'warning').length;
  const errors = results.filter((r) => r.status === 'error').length;

  const report = results
    .map((r) => `${statusLabel(r)} ${r.repo.name} — ${r.detail}`)
    .join('\n');
  note(
    `${report}\n\n${pc.green(`${ok} ok`)} · ${pc.yellow(`${warnings} avisos`)} · ${pc.red(`${errors} erros`)}`,
    'Relatório final',
  );

  outro(errors === 0 ? 'Tudo pronto! Bom código.' : 'Instalação concluída com pendências — verifique os erros acima.');
}

process.on('SIGINT', () => {
  console.log('');
  cancel('Operação interrompida (Ctrl+C).');
  process.exit(130);
});

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
