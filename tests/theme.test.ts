import { describe, expect, it } from 'vitest';
import { icons, kindIcon, theme } from '../src/ui/theme.js';

describe('theme', () => {
  it('color helpers return a string containing the input', () => {
    for (const fn of [theme.brand, theme.accent, theme.ok, theme.warn, theme.err, theme.dim]) {
      expect(fn('forge')).toContain('forge');
    }
  });
});

describe('icons', () => {
  it('exposes non-empty glyphs for every status', () => {
    for (const glyph of Object.values(icons)) expect(glyph.length).toBeGreaterThan(0);
    for (const glyph of Object.values(kindIcon)) expect(glyph.length).toBeGreaterThan(0);
  });
});
