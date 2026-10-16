import path from 'node:path';

export type InstallMethod = 'shim' | 'npm-global' | 'source';

export interface SelfUpdatePlan {
  method: InstallMethod;
  /** Comando que será executado automaticamente (somente npm global). */
  command?: { bin: string; args: string[] };
  /** Instrução para o usuário quando a atualização não é automática. */
  manual?: string;
}

function norm(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

/** Descobre como o CLI em execução foi instalado, a partir do caminho do bundle. */
export function detectInstallMethod(scriptPath: string, home: string): InstallMethod {
  const script = norm(scriptPath);
  if (script.startsWith(`${norm(path.join(home, '.forge-cli', 'bin'))}/`)) return 'shim';
  if (script.includes('/node_modules/')) return 'npm-global';
  return 'source';
}

export function planSelfUpdate(method: InstallMethod, pkgName = 'theforge-cli'): SelfUpdatePlan {
  switch (method) {
    case 'npm-global':
      return {
        method,
        command: { bin: 'npm', args: ['install', '-g', `${pkgName}@latest`] },
      };
    case 'shim':
      return {
        method,
        manual:
          'Instalação via `self install`: atualize o clone do forge-cli (git pull && npm run build) ' +
          'e rode `node dist/index.js self install` para substituir o bundle.',
      };
    default:
      return {
        method,
        manual:
          'Execução a partir do código-fonte: git pull && npm ci && npm run build ' +
          '(e `node dist/index.js self install` se quiser registrar no PATH).',
      };
  }
}
