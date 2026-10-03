import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MAX_HIERARCHY_DEPTH, MAX_SEGMENTS_PER_TASK } from '../../limits';
import type { DependencyType } from '../../model/project';
import { failure, success } from '../../result';
import { instantArbitrary, PROPERTY_TEST_TIMEOUT_MS, unwrap } from '../../testing/arbitraries';
import { at } from '../../testing/civil-time';
import {
  compareWbsNumbers,
  formatBlocks,
  formatPredecessors,
  parentWbsNumber,
  parseBlocks,
  parsePredecessors,
  readWbsNumber,
  type PredecessorReference,
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
        { wbs: '1.2', block: null, type: 'finishToStart', lagHours: 0 },
        { wbs: '3', block: null, type: 'startToStart', lagHours: 2 },
        { wbs: '4', block: null, type: 'finishToFinish', lagHours: -1 },
        { wbs: '5', block: null, type: 'startToFinish', lagHours: 0 },
        { wbs: '6', block: null, type: 'finishToStart', lagHours: 3 },
      ]),
    ).toBe('1.2, 3SS+2h, 4FF-1h, 5SF, 6FS+3h');
  });

  it('reads back what it writes', { timeout: PROPERTY_TEST_TIMEOUT_MS }, () => {
    const reference = fc.record({
      wbs: wbsArbitrary,
      block: fc.option(fc.integer({ min: 0, max: MAX_SEGMENTS_PER_TASK - 1 })),
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
        { wbs: '2', block: null, type: 'startToStart', lagHours: 3 },
        { wbs: '4', block: null, type: 'finishToFinish', lagHours: -1 },
        { wbs: '5', block: null, type: 'finishToStart', lagHours: 2 },
      ]),
    );
  });

  it('reads and writes a block of a task, numbered from 1', () => {
    expect(unwrap(parsePredecessors('3#2, 1.4 # 1 ss+2h', MAX_COUNT))).toEqual([
      { wbs: '3', block: 1, type: 'finishToStart', lagHours: 0 },
      { wbs: '1.4', block: 0, type: 'startToStart', lagHours: 2 },
    ]);
    expect(formatPredecessors([{ wbs: '3', block: 1, type: 'finishToFinish', lagHours: -1 }])).toBe(
      '3#2FF-1h',
    );
  });

  it.each([
    'x',
    '1XX',
    '1FS+',
    '1FS+2d',
    'FS',
    '1.2.',
    `1FS+2${' '.repeat(300)}h`,
    '3#0',
    `3#${String(MAX_SEGMENTS_PER_TASK + 1)}`,
    '3#',
    '#2',
  ])('refuses %j', (text) => {
    expect(parsePredecessors(text, MAX_COUNT)).toEqual(failure('INVALID_NOTATION'));
  });

  it('refuses more predecessors than allowed, counting non-empty items only', () => {
    expect(parsePredecessors('1,2,3,4,5,6', MAX_COUNT)).toEqual(failure('TOO_MANY_ITEMS'));
    expect(parsePredecessors('1,,2, ;3,4,5,,', MAX_COUNT)).toMatchObject({ ok: true });
  });

  it('keeps only the non-empty items of a list made mostly of separators', () => {
    expect(parsePredecessors(`${',; '.repeat(1_000_000)}2SS`, MAX_COUNT)).toEqual(
      success([{ wbs: '2', block: null, type: 'startToStart', lagHours: 0 }]),
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
      formatBlocks(
        [
          { durationHours: 4, gapDaysBefore: 0, startNoEarlierThan: null },
          { durationHours: 3, gapDaysBefore: 2, startNoEarlierThan: null },
        ],
        new Map(),
      ),
    ).toBe('4h; +2d 3h');
  });

  it('reads back what it writes', () => {
    const later = fc.record({
      durationHours: fc.integer({ min: 1, max: 100_000 }),
      gapDaysBefore: fc.integer({ min: 0, max: 3_650 }),
      startNoEarlierThan: fc.option(instantArbitrary),
    });
    const reference = fc.record({
      wbs: wbsArbitrary,
      block: fc.option(fc.integer({ min: 0, max: MAX_SEGMENTS_PER_TASK - 1 })),
      type: fc.constantFrom(...TYPES),
      lagHours: fc.integer({ min: -100_000, max: 100_000 }),
    });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.array(later, { maxLength: MAX_COUNT - 1 }),
        fc.array(fc.tuple(fc.nat(), reference), { maxLength: 3 }),
        (first, rest, picked) => {
          const segments = [
            { durationHours: first, gapDaysBefore: 0, startNoEarlierThan: null },
            ...rest,
          ];
          const waits = picked
            .map(([block, wait]) => ({ block: block % segments.length, reference: wait }))
            .sort((left, right) => left.block - right.block);
          const byBlock = new Map<number, PredecessorReference[]>();
          waits.forEach(({ block, reference: wait }) => {
            byBlock.set(block, [...(byBlock.get(block) ?? []), wait]);
          });
          expect(parseBlocks(formatBlocks(segments, byBlock), MAX_COUNT, MAX_COUNT)).toEqual(
            success({ segments, waits }),
          );
        },
      ),
    );
  });

  it('reads upper case, spaces and commas', () => {
    expect(parseBlocks(' 4 H ,+ 2 D  3H', MAX_COUNT, MAX_COUNT)).toEqual(
      success({
        segments: [
          { durationHours: 4, gapDaysBefore: 0, startNoEarlierThan: null },
          { durationHours: 3, gapDaysBefore: 2, startNoEarlierThan: null },
        ],
        waits: [],
      }),
    );
  });

  it('reads what each block waits for, after the keyword, separated by ampersands', () => {
    expect(
      unwrap(parseBlocks('4h AFTER 1; +0d 3h after 2.1 & 3#2SS+1h', MAX_COUNT, MAX_COUNT)),
    ).toEqual({
      segments: [
        { durationHours: 4, gapDaysBefore: 0, startNoEarlierThan: null },
        { durationHours: 3, gapDaysBefore: 0, startNoEarlierThan: null },
      ],
      waits: [
        { block: 0, reference: { wbs: '1', block: null, type: 'finishToStart', lagHours: 0 } },
        { block: 1, reference: { wbs: '2.1', block: null, type: 'finishToStart', lagHours: 0 } },
        { block: 1, reference: { wbs: '3', block: 1, type: 'startToStart', lagHours: 1 } },
      ],
    });
  });

  it('reads the start date of a later block, written after "from", in the format of the JSON file', () => {
    expect(
      unwrap(parseBlocks('4h; +1d 3h FROM 2026-10-05t14:15 after 2', MAX_COUNT, MAX_COUNT))
        .segments,
    ).toEqual([
      { durationHours: 4, gapDaysBefore: 0, startNoEarlierThan: null },
      { durationHours: 3, gapDaysBefore: 1, startNoEarlierThan: at(2026, 10, 5, 14) + 0.25 },
    ]);
    expect(
      formatBlocks(
        [
          { durationHours: 4, gapDaysBefore: 0, startNoEarlierThan: null },
          { durationHours: 3, gapDaysBefore: 0, startNoEarlierThan: at(2026, 10, 5, 14) },
        ],
        new Map(),
      ),
    ).toBe('4h; +0d 3h from 2026-10-05T14:00');
  });

  it.each([
    '4h from 2026-10-05T14:00',
    '4h; +1d 3h from 2026-10-05',
    '4h; +1d 3h from 05/10/2026 14:00',
    '4h; +1d 3h after 2 from 2026-10-05T14:00',
  ])('refuses a start date that is misplaced or not in the expected format: %j', (text) => {
    expect(parseBlocks(text, MAX_COUNT, MAX_COUNT)).toEqual(failure('INVALID_NOTATION'));
  });

  it.each([
    '4h; +1d 3h from 2026-02-30T14:00',
    '4h; +1d 3h from 2026-10-05T24:00',
    '4h; +1d 3h from 2026-10-05T14:10',
    '4h; +1d 3h from 1999-10-05T14:00',
  ])('refuses a well written start date that does not exist or is not supported: %j', (text) => {
    expect(parseBlocks(text, MAX_COUNT, MAX_COUNT)).toEqual(failure('INVALID_DATE'));
  });

  it('refuses more waits than the budget left', () => {
    expect(parseBlocks('4h after 1 & 2; +1d 3h after 3', MAX_COUNT, 2)).toEqual(
      failure('TOO_MANY_ITEMS'),
    );
  });

  it.each([
    '',
    ';',
    '+1d 4h',
    '4h; 3h',
    '4',
    '4h; +2d',
    '4h; +2 3h',
    `4${' '.repeat(300)}h`,
    '4h after',
    '4h after x',
    '4h after 1 &',
    '4h after 1 && 2',
    'after 1',
  ])('refuses %j', (text) => {
    expect(parseBlocks(text, MAX_COUNT, MAX_COUNT)).toEqual(failure('INVALID_NOTATION'));
  });

  it('refuses more blocks than allowed', () => {
    expect(parseBlocks(`1h${'; +1d 1h'.repeat(MAX_COUNT)}`, MAX_COUNT, MAX_COUNT)).toEqual(
      failure('TOO_MANY_ITEMS'),
    );
  });
});
