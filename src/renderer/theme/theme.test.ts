import { describe, expect, it } from 'vitest';
import { contrastRatio, findContrastIssues, isThemeHexColor } from './contrast';
import { SAND_GRAPHITE } from './sand-graphite';
import { THEME_COLORS, themeVariable, type Theme } from './theme';

describe('official themes', () => {
  it('keeps every colour of Sand & Graphite readable, as WCAG AA asks', () => {
    expect(findContrastIssues(SAND_GRAPHITE)).toEqual([]);
  });

  it('writes every colour of Sand & Graphite as six hexadecimal digits', () => {
    expect(THEME_COLORS.every((color) => isThemeHexColor(SAND_GRAPHITE[color]))).toBe(true);
    expect(Object.keys(SAND_GRAPHITE).sort()).toEqual([...THEME_COLORS].sort());
  });
});

describe('contrastRatio', () => {
  it.each([
    ['#000000', '#FFFFFF', 21],
    ['#FFFFFF', '#FFFFFF', 1],
    ['#777777', '#FFFFFF', 4.48],
  ])('gives %s on %s a ratio of %d', (first, second, expected) => {
    expect(contrastRatio(first, second)).toBeCloseTo(expected, 2);
    expect(contrastRatio(second, first)).toBeCloseTo(expected, 2);
  });
});

describe('findContrastIssues', () => {
  it('names each pair that is too pale, with its ratio', () => {
    const pale: Theme = { ...SAND_GRAPHITE, textSecondary: '#B0ACA5' };
    const issues = findContrastIssues(pale);
    expect(issues.map((issue) => issue.background)).toEqual(['background', 'surface', 'panel']);
    expect(issues.every((issue) => issue.foreground === 'textSecondary')).toBe(true);
    expect(issues.every((issue) => issue.ratio < issue.minimum)).toBe(true);
  });
});

describe('themeVariable', () => {
  it('names the style variables in kebab case', () => {
    expect(themeVariable('textSecondary')).toBe('--color-text-secondary');
    expect(themeVariable('text')).toBe('--color-text');
  });
});

describe('isThemeHexColor', () => {
  it.each(['#abcdef', '#ABCDEF'])('accepts %s', (value) => {
    expect(isThemeHexColor(value)).toBe(true);
  });

  it.each(['abcdef', '#abc', '#abcdeg', '#abcdef00', 'red'])('refuses %s', (value) => {
    expect(isThemeHexColor(value)).toBe(false);
  });
});
