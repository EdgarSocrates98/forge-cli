import { readFileSync } from 'node:fs';

/**
 * Versão única do CLI — lida do package.json via `import.meta.url`
 * (dist/index.js → `../package.json`; src/version.ts via tsx → mesma
 * resolução). Sem `createRequire`: o banner do tsup já injeta um — um
 * segundo declarado quebraria o bundle. Usada por `forge-cli --version`
 * e pelo clientInfo do handshake MCP — nunca duplicada.
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const CLI_VERSION = readVersion();
export const CLI_NAME = 'forge-cli';
