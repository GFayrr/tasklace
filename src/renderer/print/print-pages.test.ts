import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Project } from '../../core/model/project';
import { MIN_TEXT_POINTS, type PrintOrder } from '../../core/print/print-document';
import { printPageSvg } from '../../core/print/print-svg';
import { readPrintDocument } from '../../core/print/read-print-document';
import { scheduleProject } from '../../core/scheduling/schedule-project';
import { PROPERTY_TEST_TIMEOUT_MS } from '../../core/testing/arbitraries';
import { compileOrThrow } from '../../core/testing/civil-time';
import { richProjectArbitrary } from '../../core/testing/project-arbitrary';
import {
  link,
  milestone,
  project,
  scheduleOrThrow,
  splitTask,
  summary,
  workTask,
} from '../../core/testing/project-builder';
import { dayIndexOf } from '../../core/time';
import { loadMessages } from '../i18n/messages';
import { SAND_GRAPHITE } from '../theme/sand-graphite';
import {
  buildPrintDocument,
  PRINT_COLUMNS,
  type PrintedPlan,
  type PrintSettings,
  type PrintSource,
} from './print-pages';
import type { MeasureText } from './print-text';

const messages = await loadMessages('en');
const CHARACTER_WIDTH = 5;
const PROPERTY_PAGE_LIMIT = 6;
const DESIGN = { id: 'design', name: 'Design', color: '#2A78D6', representsPersonOrTeam: false };
const NEAR = { id: 'near', name: 'Near', color: '#2A78D7', representsPersonOrTeam: false };
const UNUSED = { id: 'unused', name: 'Unused', color: '#EB6834', representsPersonOrTeam: false };
const PLAN: Project = {
  ...project(
    [
      summary('s', { sortKey: 'a', name: 'Research' }),
      workTask('a', {
        parentId: 's',
        sortKey: 'a',
        name: 'Survey',
        progressPercent: 50,
        tagId: 'design',
      }),
      splitTask(
        'b',
        [
          [7, 0],
          [7, 2],
        ],
        { parentId: 's', sortKey: 'b', name: 'Interviews', tagId: 'near' },
      ),
      workTask('c', { sortKey: 'b', name: 'Writing' }),
      milestone('m', { sortKey: 'c', name: 'Defense' }),
    ],
    [link('a', 'b'), link('b', 'c'), link('c', 'm')],
    { tags: [DESIGN, NEAR, UNUSED] },
  ),
  name: 'Thesis',
};
const SETTINGS: PrintSettings = {
  paper: 'a4',
  orientation: 'landscape',
  period: { kind: 'whole' },
  zoom: 'automatic',
  columns: [],
};
const EXPORTED_AT = new Date(Date.UTC(2026, 9, 9, 12));

/** Measures a text at a fixed width per character, whatever its size and weight. */
const measure: MeasureText = (text) => Array.from(text).length * CHARACTER_WIDTH;

/** Returns what printing needs from a project, its schedule worked out. */
function sourceOf(plan: Project): PrintSource {
  return {
    project: plan,
    schedule: scheduleOrThrow(plan),
    calendar: compileOrThrow(plan.calendar),
    theme: SAND_GRAPHITE,
    messages,
    locale: 'en-US',
    exportedAt: EXPORTED_AT,
  };
}

/** Prints a project with settings and fails the test when printing is refused. */
function printed(plan: Project = PLAN, settings: Partial<PrintSettings> = {}): PrintedPlan {
  const result = buildPrintDocument(sourceOf(plan), { ...SETTINGS, ...settings }, measure);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

/** Lists every order of a page, those inside clips included. */
function flatten(orders: readonly PrintOrder[]): PrintOrder[] {
  return orders.flatMap((order) =>
    order.kind === 'clip' ? [order, ...flatten(order.orders)] : [order],
  );
}

/** Lists the texts of a page in the order they are written. */
function textsOf(orders: readonly PrintOrder[]): string[] {
  return flatten(orders).flatMap((order) => (order.kind === 'text' ? [order.text] : []));
}

/** Builds a plan of a given number of tasks in a row, each waiting for the one before. */
function longPlan(count: number): Project {
  const tasks = Array.from({ length: count }, (_unused, index) =>
    workTask(`t${String(index)}`, {
      sortKey: `k${String(index).padStart(5, '0')}`,
      name: `Task ${String(index + 1)}`,
    }),
  );
  const links = tasks.slice(1).map((task, index) => link(`t${String(index)}`, task.id));
  return { ...project(tasks, links), name: 'Long plan' };
}

describe('buildPrintDocument', () => {
  it('prints a small plan on one landscape A4 page that main accepts and writes as SVG', () => {
    const plan = printed();
    expect(plan.layout.pages).toHaveLength(1);
    expect(plan.document.title).toBe('Thesis');
    expect(readPrintDocument(plan.document)).toEqual({ ok: true, value: plan.document });
    expect(printPageSvg(plan.document, 0).startsWith('<svg')).toBe(true);
  });

  it('writes the title, the date of the export, the scale, the names in plan order, the legend of the tags used and the page number', () => {
    const texts = textsOf(printed().document.pages[0] ?? []);
    expect(texts.slice(0, 2)).toEqual(['Thesis', 'Exported Oct 9, 2026']);
    expect(texts).toContain('October 2026');
    expect(
      texts.filter((value) =>
        ['Name', 'Research', 'Survey', 'Interviews', 'Writing', 'Defense'].includes(value),
      ),
    ).toEqual(['Name', 'Research', 'Survey', 'Interviews', 'Writing', 'Defense']);
    expect(texts.slice(-3)).toEqual(['Design', 'Near', 'Page 1 of 1']);
    expect(texts).not.toContain('Unused');
    expect(texts).not.toContain('Critical');
  });

  it('never writes a text below 10 points', () => {
    const orders = flatten(printed(PLAN, { columns: PRINT_COLUMNS }).document.pages[0] ?? []);
    const sizes = new Set(orders.flatMap((order) => (order.kind === 'text' ? [order.size] : [])));
    expect(Math.min(...sizes)).toBe(MIN_TEXT_POINTS);
  });

  it('indents the names by level and writes summaries in bold', () => {
    const orders = flatten(printed().document.pages[0] ?? []);
    /** Finds the order that writes a name. */
    const nameOf = (name: string) =>
      orders.find((order) => order.kind === 'text' && order.text === name);
    const research = nameOf('Research');
    const survey = nameOf('Survey');
    const writing = nameOf('Writing');
    expect(research?.kind === 'text' && [research.weight, research.x]).toEqual([600, 32]);
    expect(survey?.kind === 'text' && [survey.weight, survey.x]).toEqual([400, 42]);
    expect(writing?.kind === 'text' && [writing.weight, writing.x]).toEqual([400, 32]);
  });

  it('draws the bars and links of the screen without today line, and the tags with their colors and patterns', () => {
    const orders = flatten(printed().document.pages[0] ?? []);
    const colors = new Set(orders.flatMap((order) => (order.kind === 'fill' ? [order.color] : [])));
    expect(colors.has(SAND_GRAPHITE.error.toLowerCase())).toBe(false);
    expect(colors.has('#2a78d6')).toBe(true);
    expect(orders.some((order) => order.kind === 'pattern')).toBe(true);
    expect(orders.some((order) => order.kind === 'clip')).toBe(true);
  });

  it('underlines the critical tasks and adds the key of the critical path to the legend when that option is on, with the float columns when chosen', () => {
    const critical = { ...PLAN, options: { ...PLAN.options, criticalPathEnabled: true } };
    const page = printed(critical, { columns: ['floats'] }).document.pages[0] ?? [];
    const texts = textsOf(page);
    expect(texts.slice(-4)).toEqual(['Design', 'Near', 'Critical', 'Page 1 of 1']);
    expect(texts).toContain('Total float');
    expect(texts).toContain('Free float');
    const marks = flatten(page).filter(
      (order) => order.kind === 'fill' && order.color === SAND_GRAPHITE.action.toLowerCase(),
    );
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(textsOf(printed(PLAN, { columns: ['floats'] }).document.pages[0] ?? [])).not.toContain(
      'Total float',
    );
  });

  it('prints the chosen columns, the WBS before the names and the others after them in their usual order', () => {
    const texts = textsOf(
      printed(PLAN, { columns: [...PRINT_COLUMNS].reverse() }).document.pages[0] ?? [],
    );
    const headers = ['WBS', 'Name', 'Start', 'End', 'Duration', '%', 'Predecessors'];
    expect(texts.filter((value) => headers.includes(value))).toEqual(headers);
    expect(texts).toContain('1.1');
    expect(texts).toContain('50%');
  });

  it('turns to a grid of pages for a long plan, each page repeating the scale and numbered among all pages', () => {
    const plan = printed(longPlan(60));
    expect(plan.layout.pageRows).toBe(3);
    expect(plan.document.pages).toHaveLength(plan.layout.pageColumns * 3);
    plan.document.pages.forEach((page, index) => {
      const texts = textsOf(page);
      expect(texts.at(-1)).toBe(
        `Page ${String(index + 1)} of ${String(plan.document.pages.length)}`,
      );
      expect(texts).toContain('Name');
    });
    expect(textsOf(plan.document.pages[0] ?? [])).toContain('Task 1');
    expect(textsOf(plan.document.pages.at(-1) ?? [])).toContain('Task 60');
    expect(readPrintDocument(plan.document).ok).toBe(true);
  });

  it('draws a link on every row of pages it crosses, and on no other', () => {
    const plan = longPlan(90);
    const crossing = { ...plan, dependencies: [link('t0', 't80')] };
    const printedPlan = printed(crossing, { zoom: 'month' });
    expect(printedPlan.layout.pageRows).toBe(4);
    const linkColor = SAND_GRAPHITE.textSecondary.toLowerCase();
    /** Counts the links drawn on a page. */
    const strokesOf = (index: number) =>
      flatten(printedPlan.document.pages[index] ?? []).filter(
        (order) => order.kind === 'stroke' && order.color === linkColor && order.width > 0.5,
      ).length;
    const perBand = Array.from({ length: 4 }, (_unused, band) =>
      strokesOf(band * printedPlan.layout.pageColumns),
    );
    expect(perBand.map((count) => count > 0)).toEqual([true, true, true, false]);
  });

  it('prints only the chosen days, and refuses days that end before they start', () => {
    const start = dayIndexOf(PLAN.startDate);
    const plan = printed(PLAN, { period: { kind: 'days', firstDay: start, lastDay: start + 2 } });
    expect(plan.period).toEqual({ start: start * 24, end: (start + 3) * 24 });
    expect(
      buildPrintDocument(
        sourceOf(PLAN),
        { ...SETTINGS, period: { kind: 'days', firstDay: start, lastDay: start - 1 } },
        measure,
      ),
    ).toEqual({ ok: false, error: 'EMPTY_PERIOD' });
  });

  it('prints the whole plan from the day of its first start to the day of its last end', () => {
    const schedule = scheduleOrThrow(PLAN);
    const starts = [...schedule.placements.values()].map((placement) => placement.start);
    const ends = [...schedule.placements.values()].map((placement) => placement.end);
    const { period } = printed();
    expect(period.start).toBe(dayIndexOf(Math.min(...starts)) * 24);
    expect(period.end).toBe((dayIndexOf(Math.max(...ends) - 0.25) + 1) * 24);
  });

  it('keeps a chosen zoom and picks a legible one in the automatic zoom', () => {
    expect(printed(PLAN, { zoom: 'week' }).zoom).toBe('week');
    expect(printed(PLAN, { zoom: 'automatic' }).zoom).toBe('day');
    expect(printed(longPlan(400), { zoom: 'automatic' }).zoom).not.toBe('hour');
  });

  it('passes on a refusal of the layout', () => {
    /** Measures every text as too wide for any column to leave room for the timeline. */
    const wide: MeasureText = () => 400;
    expect(
      buildPrintDocument(sourceOf(PLAN), { ...SETTINGS, columns: PRINT_COLUMNS }, wide),
    ).toEqual({
      ok: false,
      error: 'NO_ROOM_FOR_TIMELINE',
    });
  });

  it(
    'prints the first pages of any schedulable plan as a document that main accepts',
    { timeout: PROPERTY_TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(
          richProjectArbitrary,
          fc.constantFrom('automatic', 'hour', 'day', 'week', 'month' as const),
          fc.subarray([...PRINT_COLUMNS]),
          ({ project: plan }, zoom, columns) => {
            const schedule = scheduleProject(plan);
            if (!schedule.ok) {
              return;
            }
            const result = buildPrintDocument(
              {
                project: plan,
                schedule: schedule.value,
                calendar: compileOrThrow(plan.calendar),
                theme: SAND_GRAPHITE,
                messages,
                locale: 'en-US',
                exportedAt: EXPORTED_AT,
              },
              { ...SETTINGS, zoom, columns },
              measure,
              PROPERTY_PAGE_LIMIT,
            );
            if (!result.ok) {
              expect(['TOO_MANY_PAGES', 'NO_ROOM_FOR_TIMELINE']).toContain(result.error);
              return;
            }
            expect(readPrintDocument(result.value.document).ok).toBe(true);
          },
        ),
        { numRuns: 40 },
      );
    },
  );
});
