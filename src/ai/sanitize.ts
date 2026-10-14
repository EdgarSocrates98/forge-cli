/**
 * §6.3 AI mode — sanitization gate.
 *
 * Nothing reaches a prompt without passing through here first. The rules are
 * deliberately conservative (model output is untrusted, and so is anything we
 * might send to it):
 *  - keys whose NAME smells secret are dropped entirely (substring denylist);
 *  - remaining string values go through redactSecrets; if a value still
 *    changed after redaction, the whole key is dropped instead of keeping a
 *    partially masked value;
 *  - inside arrays there is no key to drop, so elements are masked in place.
 */

import { redactSecrets } from '../safety.js';

/** Case-insensitive substring denylist applied to property names. */
const DENIED_KEY = /TOKEN|SECRET|KEY|PASSWORD|PRIVATE|CREDENTIAL|AUTH/i;

const DROP = Symbol('ai-sanitize-drop');

/** Redact a free-form text blob before it reaches a prompt. */
export function sanitizeText(text: string): string {
  return redactSecrets(text);
}

function isDeniedKey(key: string): boolean {
  return DENIED_KEY.test(key);
}

/**
 * Sanitize one object entry value. Returns DROP when the value must be
 * removed from its parent object (secret-looking strings, non-JSON types).
 */
function sanitizeEntry(value: unknown): unknown {
  if (typeof value === 'string') {
    const redacted = redactSecrets(value);
    return redacted === value ? value : DROP;
  }
  if (Array.isArray(value)) return sanitizeArray(value);
  if (value && typeof value === 'object') {
    return sanitizeObject(value as Record<string, unknown>);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  return DROP;
}

/** Arrays keep their shape: strings are masked in place, non-JSON → null. */
function sanitizeArray(items: readonly unknown[]): unknown[] {
  return items.map((item) => {
    if (typeof item === 'string') return redactSecrets(item);
    const cleaned = sanitizeEntry(item);
    return cleaned === DROP ? null : cleaned;
  });
}

function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (isDeniedKey(key)) continue;
    const cleaned = sanitizeEntry(obj[key]);
    if (cleaned !== DROP) out[key] = cleaned;
  }
  return out;
}

/** Deep-sanitize arbitrary JSON-ish input for AI context payloads. */
export function sanitizeForAi(input: unknown): unknown {
  if (typeof input === 'string') return redactSecrets(input);
  if (Array.isArray(input)) return sanitizeArray(input);
  if (input && typeof input === 'object') {
    return sanitizeObject(input as Record<string, unknown>);
  }
  if (input === null || typeof input === 'number' || typeof input === 'boolean') return input;
  return null;
}

/**
 * Belt-and-suspenders check: returns the sorted list of offending key paths
 * (denylisted key names or string values that still contain secret-looking
 * content). An empty result means the value is safe to hand to the bridge.
 */
export function assertNoSecrets(input: unknown): string[] {
  const hits = new Set<string>();
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (redactSecrets(value) !== value) hits.add(path || '<root>');
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        if (isDeniedKey(key)) {
          hits.add(childPath);
          continue;
        }
        visit(child, childPath);
      }
    }
  };
  visit(input, '');
  return [...hits].sort();
}
