import { createClaudeAdapter } from './claude.js';
import { createCodexAdapter } from './codex.js';
import { createCopilotAdapter } from './copilot.js';
import { createCursorAdapter } from './cursor.js';
import { createDevinAdapter } from './devin.js';
import { defaultProbe, type HostAdapter, type HostDetection, type HostProbe } from './types.js';

// ---------------------------------------------------------------------------
// §2.5 — registro dos adaptadores de hosts de IA.
// hostAdapters(probe) permite injetar um probe falso em testes; HOST_ADAPTERS
// usa o probe real (commandOutput via execa).
// ---------------------------------------------------------------------------

export function hostAdapters(probe: HostProbe = defaultProbe): HostAdapter[] {
  return [
    createClaudeAdapter(probe),
    createCodexAdapter(probe),
    createDevinAdapter(probe),
    createCursorAdapter(probe),
    createCopilotAdapter(probe),
  ];
}

export const HOST_ADAPTERS: HostAdapter[] = hostAdapters();

export function adapterFor(
  id: string,
  adapters: readonly HostAdapter[] = HOST_ADAPTERS,
): HostAdapter | undefined {
  const norm = id.trim().toLowerCase();
  return adapters.find((a) => a.id === norm);
}

export async function detectAll(home?: string): Promise<HostDetection[]> {
  return Promise.all(HOST_ADAPTERS.map((a) => a.detect(home)));
}
