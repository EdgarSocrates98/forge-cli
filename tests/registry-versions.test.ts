import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  evalSpecifier,
  isPrerelease,
  latestStable,
  parseSpecifier,
  parseVersion,
  satisfiesRequiresPython,
} from '../src/registry/versions.js';

const v = (s: string) => parseVersion(s)!;

describe('parseVersion', () => {
  it('parses release, pre, post e dev', () => {
    expect(v('1.2.3').release).toEqual([1, 2, 3]);
    expect(v('1.0a2').pre).toEqual({ tag: 'a', n: 2 });
    expect(v('2.0rc1').pre?.tag).toBe('rc');
    expect(v('1.0.post1').post).toBe(1);
    expect(v('1.0.dev3').dev).toBe(3);
  });
  it('rejeita formatos fora do subconjunto', () => {
    expect(parseVersion('1!2.0')).toBeNull(); // epoch
    expect(parseVersion('1.0+local')).toBeNull(); // local
    expect(parseVersion('abc')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('compareVersions', () => {
  const cases: [string, string][] = [
    ['1.0.dev1', '1.0a1'],
    ['1.0a1', '1.0b1'],
    ['1.0b1', '1.0rc1'],
    ['1.0rc1', '1.0'],
    ['1.0', '1.0.post1'],
    ['1.0a1', '1.0'],
    ['0.1.0', '0.2.0'],
    ['0.9.9', '0.10.0'],
  ];
  it.each(cases)('%s < %s', (a, b) => {
    expect(compareVersions(v(a), v(b))).toBeLessThan(0);
    expect(compareVersions(v(b), v(a))).toBeGreaterThan(0);
  });
  it('empata versões equivalentes', () => {
    expect(compareVersions(v('1.0'), v('1.0.0'))).toBe(0);
    expect(compareVersions(v('0.1.0'), v('0.1.0'))).toBe(0);
  });
});

describe('specifiers', () => {
  it('avalia >=,<,==,!=,<=,>', () => {
    const py = v('3.11.4');
    expect(evalSpecifier(py, parseSpecifier('>=3.10')!)).toBe(true);
    expect(evalSpecifier(py, parseSpecifier('>=3.12')!)).toBe(false);
    expect(evalSpecifier(py, parseSpecifier('<3.12')!)).toBe(true);
    expect(evalSpecifier(py, parseSpecifier('<=3.11.4')!)).toBe(true);
    expect(evalSpecifier(py, parseSpecifier('<=3.11')!)).toBe(false);
    expect(evalSpecifier(py, parseSpecifier('==3.11.4')!)).toBe(true);
    expect(evalSpecifier(py, parseSpecifier('!=3.11.4')!)).toBe(false);
    expect(evalSpecifier(py, parseSpecifier('>3.10')!)).toBe(true);
  });
  it('avalia ==X.Y.* e !=X.Y.*', () => {
    expect(evalSpecifier(v('3.11.9'), parseSpecifier('==3.11.*')!)).toBe(true);
    expect(evalSpecifier(v('3.12.0'), parseSpecifier('==3.11.*')!)).toBe(false);
    expect(evalSpecifier(v('3.11.9'), parseSpecifier('!=3.11.*')!)).toBe(false);
  });
  it('avalia ~= (compatible release)', () => {
    expect(evalSpecifier(v('3.10.9'), parseSpecifier('~=3.10.1')!)).toBe(true);
    expect(evalSpecifier(v('3.11.0'), parseSpecifier('~=3.10.1')!)).toBe(false);
    expect(evalSpecifier(v('3.10.0'), parseSpecifier('~=3.10.1')!)).toBe(false);
    expect(evalSpecifier(v('3.11.5'), parseSpecifier('~=3.11')!)).toBe(true);
    expect(evalSpecifier(v('4.0'), parseSpecifier('~=3.11')!)).toBe(false);
  });
  it('rejeita wildcard em operadores que não ===/!=', () => {
    expect(parseSpecifier('>=3.11.*')).toBeNull();
  });
  it('rejeita ~= de componente único (sem fronteira superior)', () => {
    expect(parseSpecifier('~=3')).toBeNull();
    expect(satisfiesRequiresPython('~=3', v('3.11'))).toBeNull();
  });
});

describe('satisfiesRequiresPython', () => {
  it('conjuntos separados por vírgula', () => {
    expect(satisfiesRequiresPython('>=3.10,<4', v('3.11.4'))).toBe(true);
    expect(satisfiesRequiresPython('>=3.11,!=3.11.4', v('3.11.4'))).toBe(false);
    expect(satisfiesRequiresPython('>=3.11,!=3.11.4', v('3.11.5'))).toBe(true);
  });
  it('retorna null para especificador fora do subconjunto', () => {
    expect(satisfiesRequiresPython('>=3.10,<3.12.*', v('3.11'))).toBeNull();
    expect(satisfiesRequiresPython('===3.11', v('3.11'))).toBeNull();
  });
  it('string vazia satisfaz', () => {
    expect(satisfiesRequiresPython('', v('3.9'))).toBe(true);
  });
});

describe('latestStable / isPrerelease', () => {
  it('escolhe a maior estável ignorando pré-releases', () => {
    expect(latestStable(['0.1.0', '0.5.0', '0.6.0rc1', '0.5.5', 'bogus'])).toBe('0.5.5');
    expect(latestStable(['1.0a1', '2.0.dev3'])).toBeNull();
  });
  it('isPrerelease cobre pre e dev', () => {
    expect(isPrerelease(v('1.0rc1'))).toBe(true);
    expect(isPrerelease(v('1.0.dev1'))).toBe(true);
    expect(isPrerelease(v('1.0'))).toBe(false);
    expect(isPrerelease(v('1.0.post1'))).toBe(false);
  });
});
