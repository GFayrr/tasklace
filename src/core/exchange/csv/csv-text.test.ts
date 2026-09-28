import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { failure } from '../../result';
import { PROPERTY_TEST_TIMEOUT_MS } from '../../testing/arbitraries';
import { CSV_SEPARATORS, parseCsv, writeCsv, type CsvSeparator } from './csv-text';

const LIMITS = { maxColumns: 8, maxRows: 16 };

/** Parses CSV text with the default limits and returns its header and row cells, failing the test on a syntax error. */
function cellsOf(text: string, fallback: CsvSeparator = ','): string[][] {
  const table = parseCsv(text, fallback, LIMITS);
  if (!table.ok) {
    throw new Error(JSON.stringify(table.error));
  }
  return [[...table.value.header], ...table.value.rows.map((row) => [...row.cells])];
}

describe('parseCsv', () => {
  it('reads quoted cells holding separators, doubled quotes and line breaks', () => {
    expect(cellsOf('a,b\r\n"x, y","say ""hi""\nagain"\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nagain'],
    ]);
  });

  it('decodes a quoted cell holding more doubled quotes than one decoding slice, across slice boundaries', () => {
    const pairs = 200_000;
    const table = parseCsv(`a\n"${'x""'.repeat(pairs)}y"\n`, ',', LIMITS);
    expect(table.ok && table.value.rows[0]?.cells[0]).toBe(`${'x"'.repeat(pairs)}y`);
    const onlyQuotes = parseCsv(`a\n"${'""'.repeat(pairs)}"`, ',', LIMITS);
    expect(onlyQuotes.ok && onlyQuotes.value.rows[0]?.cells[0]).toBe('"'.repeat(pairs));
  });

  it('accepts Windows, Unix and old Mac line ends, with or without a final one', () => {
    for (const text of ['a\r\n1\r\n2', 'a\n1\n2\n', 'a\r1\r2\r']) {
      expect(cellsOf(text)).toEqual([['a'], ['1'], ['2']]);
    }
  });

  it('numbers rows as a spreadsheet does, skipping blank and separator-only lines', () => {
    const table = parseCsv('a;b\n\n;\n1;2\n "x" ; \n', ';', LIMITS);
    expect(table.ok && table.value.rows.map((row) => row.rowNumber)).toEqual([4, 5]);
  });

  it('counts a multi-line quoted cell as a single row', () => {
    const table = parseCsv('a\n"1\n2"\n3', ',', LIMITS);
    expect(table.ok && table.value.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
  });

  it('keeps one cell per header column, filling short rows and flagging dropped non-empty cells', () => {
    const table = parseCsv('a,b\n1\n1,2,,\n1,2,3', ',', LIMITS);
    expect(table.ok && table.value.rows).toEqual([
      { rowNumber: 2, cells: ['1'], hasExtraCells: false },
      { rowNumber: 3, cells: ['1', '2'], hasExtraCells: false },
      { rowNumber: 4, cells: ['1', '2'], hasExtraCells: true },
    ]);
  });

  it.each<[string, CsvSeparator, CsvSeparator]>([
    ['a;b;c', ',', ';'],
    ['a,b,c', ';', ','],
    ['a\tb\tc', ',', '\t'],
    ['a,b;c', ';', ';'],
    ['a,b;c', ',', ','],
    ['"a;b",c', ';', ','],
    ['single', '\t', '\t'],
  ])('detects the separator of %j with %j as the regional one', (text, fallback, expected) => {
    const table = parseCsv(text, fallback, LIMITS);
    expect(table.ok && table.value.separator).toBe(expected);
  });

  it('reads an empty text as a header with one empty column and no rows', () => {
    expect(cellsOf('')).toEqual([['']]);
  });

  it.each([
    ['a\n"unterminated', 2],
    ['"a"b\n1', 1],
    ['a\n1\n"x"y', 3],
  ])('refuses the badly quoted text %j at its row', (text, rowNumber) => {
    expect(parseCsv(text, ',', LIMITS)).toEqual(failure({ code: 'INVALID_CSV', rowNumber }));
  });

  it('refuses more columns or rows than the limits, and accepts them exactly', () => {
    const columns = (count: number) => Array.from({ length: count }, () => 'h').join(',');
    const rows = (count: number) => `h${'\nx'.repeat(count)}`;
    expect(parseCsv(columns(LIMITS.maxColumns), ',', LIMITS).ok).toBe(true);
    expect(parseCsv(columns(LIMITS.maxColumns + 1), ',', LIMITS)).toEqual(
      failure({ code: 'TOO_MANY_COLUMNS' }),
    );
    expect(parseCsv(rows(LIMITS.maxRows), ',', LIMITS).ok).toBe(true);
    expect(parseCsv(rows(LIMITS.maxRows + 1), ',', LIMITS)).toEqual(
      failure({ code: 'TOO_MANY_ROWS' }),
    );
  });

  it('never throws on random text', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('a', ',', ';', '"', '\n', '\r', '\t', ' ') }),
        (text) => {
          expect(() => parseCsv(text, ';', LIMITS)).not.toThrow();
        },
      ),
    );
  });
});

describe('writeCsv', () => {
  it('quotes only the cells that need it and ends every record with a Windows line end', () => {
    expect(writeCsv([['a', 'b;c', 'd"e', 'f\ng', ' h ']], ';')).toBe(
      'a;"b;c";"d""e";"f\ng"; h \r\n',
    );
  });

  it(
    'writes records, empty cells included, that read back identically under a header of plain names',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      const cell = fc.string({
        unit: fc.constantFrom('a', 'é', ',', ';', '"', '\n', '\r', '\t', ' '),
      });

      fc.assert(
        fc.property(
          fc.constantFrom(...CSV_SEPARATORS),
          fc.integer({ min: 1, max: LIMITS.maxColumns }),
          fc.array(fc.nat(), { maxLength: LIMITS.maxRows }),
          fc.array(cell, {
            minLength: LIMITS.maxColumns * (LIMITS.maxRows + 1),
            maxLength: LIMITS.maxColumns * (LIMITS.maxRows + 1),
          }),
          (separator, width, rowSeeds, texts) => {
            const header = Array.from({ length: width }, (_unused, column) => `h${String(column)}`);
            const rows = rowSeeds
              .map((_seed, row) => texts.slice(row * width, (row + 1) * width))
              .filter((cells) => cells.some((text) => text.trim() !== ''));
            const records = [header, ...rows];
            const table = parseCsv(writeCsv(records, separator), separator, LIMITS);
            expect(
              table.ok && [table.value.header, ...table.value.rows.map((row) => row.cells)],
            ).toEqual(records);
          },
        ),
      );
    },
  );
});
