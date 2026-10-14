import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../core/model/project';
import { pageSizeOf } from '../../core/print/paper';
import { printCostOf, type PrintCost } from '../../core/print/print-cost';
import { compileOrThrow } from '../../core/testing/civil-time';
import { project, scheduleOrThrow, workTask } from '../../core/testing/project-builder';
import { loadMessages } from '../i18n/messages';
import { SAND_GRAPHITE } from '../theme/sand-graphite';
import { buildPrintDocument, type PrintSettings, type PrintSource } from './print-pages';
import type { MeasureText } from './print-text';

const limits = vi.hoisted(() => ({
  orders: Number.POSITIVE_INFINITY,
  pathNumbers: Number.POSITIVE_INFINITY,
  tiles: Number.POSITIVE_INFINITY,
}));

vi.mock('../../core/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/limits')>()),
  get MAX_PRINT_ORDERS() {
    return limits.orders;
  },
  get MAX_PRINT_DOCUMENT_PATH_NUMBERS() {
    return limits.pathNumbers;
  },
  get MAX_PRINT_PATTERN_TILES() {
    return limits.tiles;
  },
}));

const messages = await loadMessages('en');
const CHARACTER_WIDTH = 5;
const TASK_COUNT = 60;
const EXPECTED_TILES = 3_054;
const TAGS = [
  { id: 'design', name: 'Design', color: '#2A78D6', representsPersonOrTeam: false },
  { id: 'near', name: 'Near', color: '#2A78D7', representsPersonOrTeam: false },
];
const SETTINGS: PrintSettings = {
  paper: 'a4',
  orientation: 'landscape',
  period: { kind: 'whole' },
  zoom: 'automatic',
  columns: [],
};

/** Measures a text at a fixed width per character, whatever its size and weight. */
const measure: MeasureText = (text) => Array.from(text).length * CHARACTER_WIDTH;

/** Builds a plan of unlinked tasks long enough to fill three printed pages, every other one with a tag drawn with a pattern. */
function longPlan(): Project {
  const tasks = Array.from({ length: TASK_COUNT }, (_unused, index) =>
    workTask(`t${String(index)}`, {
      sortKey: `k${String(index).padStart(3, '0')}`,
      tagId: index % 2 === 0 ? 'design' : 'near',
    }),
  );
  return { ...project(tasks, [], { tags: TAGS }), name: 'Long plan' };
}

/** Returns what printing needs from a project, its schedule worked out. */
function sourceOf(plan: Project): PrintSource {
  return {
    project: plan,
    schedule: scheduleOrThrow(plan),
    calendar: compileOrThrow(plan.calendar),
    theme: SAND_GRAPHITE,
    messages,
    locale: 'en-US',
    exportedAt: new Date(2026, 9, 9, 12),
  };
}

/** Prints the long plan, all its pages or the first ones up to a limit. */
function print(pageLimit?: number) {
  return buildPrintDocument(sourceOf(longPlan()), SETTINGS, measure, pageLimit);
}

/** Counts the pages of a printed plan, or gives back the refusal. */
function pagesOf(result: ReturnType<typeof print>): number | string {
  return result.ok ? result.value.document.pages.length : result.error;
}

/** Adds up the cost of the pages of the long plan printed without limits. */
function costOfPages(): PrintCost {
  const whole = print();
  if (!whole.ok) {
    throw new Error(whole.error);
  }
  expect(whole.value.document.pages).toHaveLength(3);
  return printCostOf(whole.value.document.pages.flat(), pageSizeOf('a4', 'landscape'));
}

describe('the limits of a printed document', () => {
  beforeEach(() => {
    limits.orders = Number.POSITIVE_INFINITY;
    limits.pathNumbers = Number.POSITIVE_INFINITY;
    limits.tiles = Number.POSITIVE_INFINITY;
  });

  it('prints pages that hold exactly as many orders as a document allows, and refuses one more', () => {
    const cost = costOfPages();
    limits.orders = cost.orders;
    expect(pagesOf(print())).toBe(3);
    limits.orders = cost.orders - 1;
    expect(print()).toEqual({ ok: false, error: 'TOO_DETAILED' });
    expect(pagesOf(print(1))).toBe(1);
  });

  it('prints pages that hold exactly as many numbers of paths as a document allows, and refuses one more', () => {
    const cost = costOfPages();
    limits.pathNumbers = cost.pathNumbers;
    expect(pagesOf(print())).toBe(3);
    limits.pathNumbers = cost.pathNumbers - 1;
    expect(print()).toEqual({ ok: false, error: 'TOO_DETAILED' });
    expect(pagesOf(print(1))).toBe(1);
  });

  it('prints pages whose patterns need exactly as many tiles as a document allows, and refuses one more', () => {
    const cost = costOfPages();
    expect(cost.tiles).toBe(EXPECTED_TILES);
    limits.tiles = cost.tiles;
    expect(pagesOf(print())).toBe(3);
    limits.tiles = cost.tiles - 1;
    expect(print()).toEqual({ ok: false, error: 'TOO_DETAILED' });
    expect(pagesOf(print(1))).toBe(1);
  });
});
