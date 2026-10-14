import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface ForgeConfig {
  dir?: string;
  only?: string[];
  timeout?: number;
  json?: boolean;
  shallow?: boolean;
  jobs?: number;
  /** §6.3 AI-assisted mode — opt-in, local bridge command, never a hardwired provider. */
  ai?: {
    enabled?: boolean;
    command?: string[];
    maxContextBytes?: number;
    timeoutMs?: number;
    cacheTtlMs?: number;
  };
}

export type ConfigResult = { config: ForgeConfig } | { error: string } | null;

export function loadConfig(targetDir: string): ConfigResult {
  const file = path.join(targetDir, 'forge-cli.config.json');
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { error: 'invalid-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'not-an-object' };
  }
  const raw = parsed as Record<string, unknown>;
  const config: ForgeConfig = {};
  if (typeof raw.dir === 'string' && raw.dir.trim()) config.dir = raw.dir;
  if (Array.isArray(raw.only) && raw.only.every((n) => typeof n === 'string')) {
    config.only = raw.only.filter((n) => (n as string).trim().length > 0) as string[];
  }
  if (typeof raw.timeout === 'number' && Number.isFinite(raw.timeout) && raw.timeout > 0) {
    config.timeout = Math.floor(raw.timeout);
  }
  if (typeof raw.json === 'boolean') config.json = raw.json;
  if (typeof raw.shallow === 'boolean') config.shallow = raw.shallow;
  if (
    typeof raw.jobs === 'number' &&
    Number.isInteger(raw.jobs) &&
    raw.jobs >= 1 &&
    raw.jobs <= 8
  ) {
    config.jobs = raw.jobs;
  }
  if (raw.ai && typeof raw.ai === 'object' && !Array.isArray(raw.ai)) {
    const ai = raw.ai as Record<string, unknown>;
    const parsed: NonNullable<ForgeConfig['ai']> = {};
    if (typeof ai.enabled === 'boolean') parsed.enabled = ai.enabled;
    if (
      Array.isArray(ai.command) &&
      ai.command.length > 0 &&
      ai.command.every((c) => typeof c === 'string' && c.trim().length > 0)
    ) {
      parsed.command = ai.command as string[];
    }
    if (
      typeof ai.maxContextBytes === 'number' &&
      Number.isInteger(ai.maxContextBytes) &&
      ai.maxContextBytes >= 512 &&
      ai.maxContextBytes <= 262144
    ) {
      parsed.maxContextBytes = ai.maxContextBytes;
    }
    if (
      typeof ai.timeoutMs === 'number' &&
      Number.isInteger(ai.timeoutMs) &&
      ai.timeoutMs >= 1000 &&
      ai.timeoutMs <= 300000
    ) {
      parsed.timeoutMs = ai.timeoutMs;
    }
    if (
      typeof ai.cacheTtlMs === 'number' &&
      Number.isInteger(ai.cacheTtlMs) &&
      ai.cacheTtlMs >= 0 &&
      ai.cacheTtlMs <= 86400000
    ) {
      parsed.cacheTtlMs = ai.cacheTtlMs;
    }
    if (Object.keys(parsed).length > 0) config.ai = parsed;
  }
  return { config };
}
