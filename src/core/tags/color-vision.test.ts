import { describe, expect, it } from 'vitest';
import { SIMULATED_VISIONS, colorDistance, isHexColor, toOklab } from './color-vision';

const OKLAB_PRECISION = 3;

describe('isHexColor', () => {
  it.each(['#000000', '#ffffff', '#1E3A5F', '#a0B1c2'])('accepts %s', (value) => {
    expect(isHexColor(value)).toBe(true);
  });

  it.each(['', 'red', '#fff', '#12345', '#1234567', '#GGGGGG', '123456', ' #123456', '#123456 '])(
    'rejects "%s"',
    (value) => {
      expect(isHexColor(value)).toBe(false);
    },
  );
});

describe('toOklab', () => {
  it.each<[string, [number, number, number]]>([
    ['#ffffff', [1, 0, 0]],
    ['#000000', [0, 0, 0]],
    ['#ff0000', [0.62796, 0.22486, 0.12585]],
    ['#00ff00', [0.86644, -0.23389, 0.1795]],
    ['#0000ff', [0.45201, -0.03246, -0.31153]],
  ])('matches the published OKLab reference values for %s', (color, expected) => {
    const actual = toOklab(color);
    expected.forEach((value, index) => {
      expect(actual[index]).toBeCloseTo(value, OKLAB_PRECISION);
    });
  });

  it('keeps grays gray under every simulated color vision', () => {
    for (const vision of SIMULATED_VISIONS) {
      const [, a, b] = toOklab('#808080', vision);
      expect(Math.abs(a)).toBeLessThan(0.01);
      expect(Math.abs(b)).toBeLessThan(0.01);
    }
  });
});

describe('colorDistance', () => {
  it('is zero between a color and itself, and symmetric', () => {
    expect(colorDistance('#2a78d6', '#2a78d6', 'normal')).toBe(0);
    expect(colorDistance('#2a78d6', '#e34948', 'deuteranopia')).toBeCloseTo(
      colorDistance('#e34948', '#2a78d6', 'deuteranopia'),
    );
  });

  it('puts black and white 100 apart', () => {
    expect(colorDistance('#000000', '#ffffff', 'normal')).toBeCloseTo(100, 1);
    expect(colorDistance('#000000', '#ffffff', 'grayscale')).toBeCloseTo(100, 1);
  });

  it('agrees with the reference palette validator on known pairs', () => {
    expect(colorDistance('#eda100', '#1baf7a', 'protanopia')).toBeCloseTo(9.1, 1);
    expect(colorDistance('#884800', '#a00070', 'normal')).toBeCloseTo(19.5, 1);
  });

  it('shows that red and green collapse for red-green color blindness only', () => {
    const red = '#d03030';
    const green = '#3a9a30';
    expect(colorDistance(red, green, 'normal')).toBeGreaterThan(20);
    expect(colorDistance(red, green, 'deuteranopia')).toBeLessThan(
      colorDistance(red, green, 'normal') / 2,
    );
  });

  it('only keeps lightness differences in grayscale', () => {
    expect(colorDistance('#ff0000', '#ff0000', 'grayscale')).toBe(0);
    expect(colorDistance('#ff0000', '#0000ff', 'grayscale')).toBeGreaterThan(0);
    expect(colorDistance('#ff0000', '#0000ff', 'grayscale')).toBeLessThan(
      colorDistance('#ff0000', '#0000ff', 'normal'),
    );
  });
});
