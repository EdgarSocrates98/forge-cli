import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { contractValidator } from './contracts/index.js';

export interface ForgeManifest {
  forgeId?: string;
  cli?: string;
  mcpCommand?: string[];
}

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_BYTES = 64 * 1024;

/**
 * Lê `forge.json` de uma Forja, se existir. É opcional e não confiável: só campos
 * conhecidos e estritamente validados (sem caminhos, espaços ou opções).
 * Quando `schema` é declarado, o documento precisa valer como
 * `forge/ForgeDescriptor/v1` — um manifest hostil que declara schema errado
 * é descartado por inteiro (fail-closed), nunca rebaixado em silêncio.
 */
export function readForgeManifest(repoDir: string): ForgeManifest | null {
  const file = path.join(repoDir, 'forge.json');
  try {
    if (!existsSync(file) || statSync(file).size > MAX_BYTES) return null;
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.schema === 'string') {
      if (contractValidator().validate('forge/ForgeDescriptor/v1', obj).length) return null;
    }
    const manifest: ForgeManifest = {};
    if (typeof obj.forge_id === 'string' && SAFE_TOKEN.test(obj.forge_id)) {
      manifest.forgeId = obj.forge_id;
    }
    if (typeof obj.cli === 'string' && SAFE_TOKEN.test(obj.cli)) manifest.cli = obj.cli;
    if (
      Array.isArray(obj.mcp_command) &&
      obj.mcp_command.length > 0 &&
      obj.mcp_command.every((t) => typeof t === 'string' && SAFE_TOKEN.test(t))
    ) {
      manifest.mcpCommand = obj.mcp_command as string[];
    }
    return manifest.forgeId || manifest.cli || manifest.mcpCommand ? manifest : null;
  } catch {
    return null;
  }
}
