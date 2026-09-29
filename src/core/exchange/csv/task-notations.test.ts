import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MAX_HIERARCHY_DEPTH } from '../../limits';
import type { DependencyType } from '../../model/project';
import { failure, success } from '../../result';
import { PROPERTY_TEST_TIMEOUT_MS } from '../../testing/arbitraries';
import {
  compareWbsNumbers,
  formatBlocks,
  formatPredecessors,
  parentWbsNumber,
  parseBlocks,
  parsePredecessors,
  readWbsNumber,
} from './task-notations';

const TYPES: readonly DependencyType[] = [
  'finishToStart',
  'startToStart',
  'finishToFinish',
  'startToFinish',
];
const MAX_COUNT = 5;
const QUICK_MILLISECONDS = 50;

const wbsArbitrary = fc
  .array(fc.integer({ min: 1, max: 99_999 }), { minLength: 1, maxLength: MAX_HIERARCHY_DEPTH })
  .map((parts) => parts.join('.'));

describe('WBS numbers', () => {
  it.each([
    ['1', '1'],
    [' 1.2 ', '1.2'],
    ['01.002', '1.2'],
  ])('reads %j as %j', (text, expected) => {
    expect(readWbsNumber(text)).toBe(expected);
  });

  it.each(['', '1.', '.1', '1..2', 'a', '1.2a', '1,2', '1234567890'])('refuses %j', (text) => {
    expect(readWbsNumber(text)).toBeNull();
  });

  it('refuses a number deeper than the hierarchy limit', () => {
    const deepest = Array.from({ length: MAX_HIERARCHY_DEPTH }, () => '1').join('.');
    expect(readWbsNumber(deepest)).toBe(deepest);
    expect(readWbsNumber(`${deepest}.1`)).toBeNull();
  });

  it('orders numbers as the task table does', () => {
    const numbers = ['10', '2', '1.10', '1', '1.2', '1.2.1'];
    expect([...numbers].sort(compareWbsNumbers)).toEqual(['1', '1.2', '1.2.1', '1.10', '2', '10']);
  });

  it('finds the parent number', () => {
    expect(parentWbsNumber('1.2.3')).toBe('1.2');
    expect(parentWbsNumber('4')).toBeNull();
  });
});

describe('predecessor notation', () => {
  it('writes finish-to-start without lag as the bare number, and every other case in full', () => {
    expect(
      formatPredecessors([
        { wbs: '1.2', type: 'finishToStart', lagHours: 0 },
        { wbs: '3', type: 'startToStart', lagHours: 2 },
        { wbs: '4', type: 'finishToFinish', lagHours: -1 },
        { wbs: '5', type: 'startToFinish', lagHours: 0 },
        { wbs: '6', type: 'finishToStart', lagHours: 3 },
      ]),
    ).toBe('1.2, 3SS+2h, 4FF-1h, 5SF, 6FS+3h');
  });

  it('reads back what it writes', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
    const reference = fc.record({
      wbs: wbsArbitrary,
      type: fc.constantFrom(...TYPES),
      lagHours: fc.integer({ min: -100_000, max: 100_000 }),
    });
    fc.assert(
      fc.property(fc.array(reference, { maxLength: MAX_COUNT }), (references) => {
        expect(parsePredecessors(formatPredecessors(references), MAX_COUNT)).toEqual(
          success(references),
        );
      }),
    );
  });

  it('reads lower case, spaces, semicolons, a lag without unit and empty items', () => {
    expect(parsePredecessors(' 2ss + 3 ; 4 ff-1h,, 5+2', MAX_COUNT)).toEqual(
      success([
        { wbs: '2', type: 'startToStart', lagHours: 3 },
        { wbs: '4', type: 'finishToFinish', lagHours: -1 },
        { wbs: '5', type: 'finishToStart', lagHours: 2 },
      ]),
    );
  });

  it.each(['x', '1XX', '1FS+', '1FS+2d', 'FS', '1.2.', `1FS+2${' '.repeat(300)}h`])(
    'refuses %j',
    (text) => {
      expect(parsePredecessors(text, MAX_COUNT)).toEqual(failure('INVALID_NOTATION'));
    },
  );

  it('refuses more predecessors than allowed, counting non-empty items only', () => {
    expect(parsePredecessors('1,2,3,4,5,6', MAX_COUNT)).toEqual(failure('TOO_MANY_ITEMS'));
    expect(parsePredecessors('1,,2, ;3,4,5,,', MAX_COUNT)).toMatchObject({ ok: true });
  });

  it('keeps only the non-empty items of a list made mostly of separators', () => {
    expect(parsePredecessors(`${',; '.repeat(1_000_000)}2SS`, MAX_COUNT)).toEqual(
      success([{ wbs: '2', type: 'startToStart', lagHours: 0 }]),
    );
  });

  it('refuses a huge list at once, before splitting it', () => {
    const start = performance.now();
    expect(parsePredecessors('1,'.repeat(10_000_000), MAX_COUNT)).toEqual(
      failure('TOO_MANY_ITEMS'),
    );
    expect(performance.now() - start).toBeLessThan(QUICK_MILLISECONDS);
  });
});

describe('block notation', () => {
  it('writes each later block after its gap in days', () => {
    expect(
      formatBlocks([
        { durationHours: 4, gapDaysBefore: 0 },
        { durationHours: 3, gapDaysBefore: 2 },
      ]),
    ).toBe('4h; +2d 3h');
  });

  it('reads back what it writes', () => {
    const later = fc.record({
      durationHours: fc.integer({ min: 1, max: 100_000 }),
      gapDaysBefore: fc.integer({ min: 1, max: 3_650 }),
    });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.array(later, { maxLength: MAX_COUNT - 1 }),
        (first, rest) => {
          const segments = [{ durationHours: first, gapDaysBefore: 0 }, ...rest];
          expect(parseBlocks(formatBlocks(segments), MAX_COUNT)).toEqual(success(segments));
        },
      ),
    );
  });

  it('reads upper case, spaces and commas', () => {
    expect(parseBlocks(' 4 H ,+ 2 D  3H', MAX_COUNT)).toEqual(
      success([
        { durationHours: 4, gapDaysBefore: 0 },
        { durationHours: 3, gapDaysBefore: 2 },
      ]),
    );
  });

  it.each(['', ';', '+1d 4h', '4h; 3h', '4', '4h; +2d', '4h; +2 3h', `4${' '.repeat(300)}h`])(
    'refuses %j',
    (text) => {
      expect(parseBlocks(text, MAX_COUNT)).toEqual(failure('INVALID_NOTATION'));
    },
  );

  it('refuses more blocks than allowed', () => {
    expect(parseBlocks(`1h${'; +1d 1h'.repeat(MAX_COUNT)}`, MAX_COUNT)).toEqual(
      failure('TOO_MANY_ITEMS'),
    );
  });
});
