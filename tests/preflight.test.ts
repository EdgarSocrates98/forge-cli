import { describe, expect, it } from 'vitest';
import { isNodeSupported } from '../src/preflight.js';

describe('isNodeSupported', () => {
  it('accepts Node >= 20', () => {
    expect(isNodeSupported('v20.0.0')).toBe(true);
    expect(isNodeSupported('v24.16.0')).toBe(true);
  });

  it('rejects Node < 20', () => {
    expect(isNodeSupported('v18.19.2')).toBe(false);
    expect(isNodeSupported('v16.20.0')).toBe(false);
  });

  it('rejects unparseable versions', () => {
    expect(isNodeSupported('not-a-version')).toBe(false);
    expect(isNodeSupported('')).toBe(false);
  });
});
