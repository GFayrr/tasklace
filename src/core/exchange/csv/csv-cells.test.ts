import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PROPERTY_TEST_TIMEOUT_MS } from '../../testing/arbitraries';
import { neutralizeFormula, restoreFormula } from './csv-cells';

describe('formula neutralization', () => {
  it.each(['=1+1', '+33 6', '-5', '@SUM(A1)', '\tx', '\rx'])(
    'prefixes %j with an apostrophe',
    (cell) => {
      expect(neutralizeFormula(cell)).toBe(`'${cell}`);
    },
  );

  it.each(['plain', '', '1.2', "'plain", 'a=b', ' =x'])('leaves %j unchanged', (cell) => {
    expect(neutralizeFormula(cell)).toBe(cell);
    expect(restoreFormula(cell)).toBe(cell);
  });

  it('escapes a cell that already looks escaped, so that the import gives it back', () => {
    expect(neutralizeFormula("'=x")).toBe("''=x");
    expect(neutralizeFormula("''")).toBe("'''");
  });

  it(
    'gives back every text exactly after an export and an import',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      const text = fc.string({
        unit: fc.constantFrom("'", '=', '+', '-', '@', '\t', '\r', 'a', ' '),
      });
      fc.assert(
        fc.property(text, (cell) => {
          expect(restoreFormula(neutralizeFormula(cell))).toBe(cell);
        }),
      );
    },
  );

  it('never leaves a formula trigger at the start of an exported cell', () => {
    fc.assert(
      fc.property(fc.string(), (cell) => {
        expect(['=', '+', '-', '@', '\t', '\r']).not.toContain(neutralizeFormula(cell).charAt(0));
      }),
    );
  });
});
