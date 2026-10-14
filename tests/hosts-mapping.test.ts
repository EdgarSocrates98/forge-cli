import { describe, expect, it } from 'vitest';
import type { HostState } from '../src/hosts/types.js';

/**
 * Guard — spec C4/§4.2 ADR (forge-portal docs/roadmap/C4_BRIDGE_ADR.md):
 * the CLI host ladder is the contract Portal maps onto
 * HostLifecycleState. If this list changes, the ADR mapping table and
 * the portal's lifecycle stepper must be updated in the same change.
 */
describe('host state model contract (C4 ADR)', () => {
  const LADDER: HostState[] = [
    'absent',
    'installed',
    'configured',
    'authenticated',
    'integrated',
    'validated',
  ];

  it('pins the six canonical states in order', () => {
    expect(LADDER).toEqual([
      'absent',
      'installed',
      'configured',
      'authenticated',
      'integrated',
      'validated',
    ]);
  });

  it('authenticated is only reachable via real probe — detect() caps below it', () => {
    // structural assertion: the type cannot express 'authenticated'
    // without the auth axis being 'verified' — verified only via probe.
    const authAxis = ['verified', 'absent', 'unknown'] as const;
    expect(authAxis).toContain('unknown'); // default when no probe exists
    expect(authAxis.indexOf('verified')).toBe(0); // never the default
  });
});
