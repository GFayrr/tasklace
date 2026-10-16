import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_HIERARCHY_DEPTH } from '../../core/limits';
import type { Project } from '../../core/model/project';
import { MIN_TEXT_POINTS, type PrintOrder } from '../../core/print/print-document';
import { printPageSvg } from '../../core/print/print-svg';
import { readPrintDocument } from '../../core/print/read-print-document';
import { scheduleProject } from '../../core/scheduling/schedule-project';
import { PROPERTY_TEST_TIMEOUT_MS } from '../../core/testing/arbitraries';
import { at, compileOrThrow } from '../../core/testing/civil-time';
import { checkedOrThrow } from '../../core/testing/print-arbitrary';
import { richProjectArbitrary } from '../../core/testing/project-arbitrary';
import {
  link,
  milestone,
  project,
  scheduleOrThrow,
  splitTask,
  summary,
  workTask,
  testId,
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
const DESIGN = {
  id: testId('design'),
  name: 'Design',
  color: '#2A78D6',
  representsPersonOrTeam: false,
};
const NEAR = { id: testId('near'), name: 'Near', color: '#2A78D7', representsPersonOrTeam: false };
const UNUSED = {
  id: testId('unused'),
  name: 'Unused',
  color: '#EB6834',
  representsPersonOrTeam: false,
};
const PLAN: Project = {
  ...project(
    [
      summary('s', { sortKey: 'a', name: 'Research' }),
      workTask('a', {
        parentId: testId('s'),
        sortKey: 'a',
        name: 'Survey',
        progressPercent: 50,
        tagId: testId('design'),
      }),
      splitTask(
        'b',
        [
          [7, 0],
          [7, 2],
        ],
        { parentId: testId('s'), sortKey: 'b', name: 'Interviews', tagId: testId('near') },
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
const EXPORTED_AT = new Date(2026, 9, 9, 12);

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
    expect(printPageSvg(checkedOrThrow(plan.document), 0)).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="841\.89pt" height="595\.28pt" viewBox="0 0 841\.89 595\.28" font-family="Jost Print" xml:space="preserve">.*<\/svg>$/,
    );
  });

  it('writes the title, the date of the export, the scale, the names in plan order, the legend of the tags used and the page number', () => {
    expect(textsOf(printed().document.pages[0] ?? [])).toEqual([
      'Thesis',
      'Exported Oct 9, 2026',
      'September 2026',
      'October 2026',
      '28',
      '29',
      '30',
      '1',
      '2',
      'Name',
      'Research',
      'Survey',
      'Interviews',
      'Writing',
      'Defense',
      'Design',
      'Near',
      'Page 1 of 1',
    ]);
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

  it('keeps room for every name of the deepest hierarchy, the indent stopping at 140 points', () => {
    const levels = MAX_HIERARCHY_DEPTH - 1;
    const tasks = [
      ...Array.from({ length: levels }, (_unused, index) =>
        summary(`s${String(index)}`, {
          parentId: index === 0 ? null : `s${String(index - 1)}`,
          name: `Level ${String(index)}`,
        }),
      ),
      workTask('a', { parentId: testId(`s${String(levels - 1)}`), name: 'Deepest task' }),
    ];
    const orders = printed({ ...project(tasks, []), name: 'Deep' }).document.pages.flatMap((page) =>
      flatten(page),
    );
    const names = orders.flatMap((order) =>
      order.kind === 'text' && /^(Level \d+|Deepest task)$/.test(order.text)
        ? [[order.text, order.x]]
        : [],
    );
    expect(names).toEqual([
      ...Array.from({ length: levels }, (_unused, index) => [
        `Level ${String(index)}`,
        32 + Math.min(index * 10, 140),
      ]),
      ['Deepest task', 32 + 140],
    ]);
  });

  it('cuts a column longer than 220 points, so that one long cell never takes the room of the timeline', () => {
    const tasks = Array.from({ length: 41 }, (_unused, index) =>
      workTask(`t${String(index)}`, { sortKey: `k${String(index).padStart(2, '0')}` }),
    );
    const links = tasks.slice(0, -1).map((task) => link(task.id, 't40'));
    const plan = printed(
      { ...project(tasks, links), name: 'Linked' },
      { orientation: 'portrait', columns: ['predecessors'] },
    );
    const texts = plan.document.pages.flatMap((page) => textsOf(page));
    const full = Array.from({ length: 40 }, (_unused, index) => String(index + 1)).join(', ');
    expect(texts.filter((text) => text.startsWith('1, 2'))).toEqual([
      `${full.slice(0, 220 / CHARACTER_WIDTH - 1).trimEnd()}…`,
    ]);
  });

  it('draws the bars and links of the screen without today line, and the tags with their colors and patterns', () => {
    const orders = flatten(printed().document.pages[0] ?? []);
    const colors = new Set(orders.flatMap((order) => (order.kind === 'fill' ? [order.color] : [])));
    expect(colors.has(SAND_GRAPHITE.error.toLowerCase())).toBe(false);
    expect(colors.has('#2a78d6')).toBe(true);
    expect(orders.filter((order) => order.kind === 'pattern')).toHaveLength(3);
    expect(orders.filter((order) => order.kind === 'clip')).toHaveLength(5);
  });

  it('underlines the critical tasks and adds the key of the critical path to the legend when that option is on, with the float columns when chosen', () => {
    const critical = { ...PLAN, options: { ...PLAN.options, criticalPathEnabled: true } };
    const page = printed(critical, { columns: ['floats'] }).document.pages[0] ?? [];
    const texts = textsOf(page);
    expect(texts.slice(-4)).toEqual(['Design', 'Near', 'Critical', 'Page 1 of 1']);
    expect(texts.slice(texts.indexOf('Total float'), -4)).toEqual([
      'Total float',
      '0 h',
      '0 h',
      '0 h',
      '0 h',
      'Free float',
      '0 h',
      '0 h',
      '0 h',
      '0 h',
    ]);
    const markTops = flatten(page).flatMap((order) =>
      order.kind === 'fill' &&
      order.color === SAND_GRAPHITE.action.toLowerCase() &&
      order.shape.kind === 'rect'
        ? [Math.round(order.shape.y)]
        : [],
    );
    expect(markTops).toEqual([130, 146, 146, 162, 178, 558]);
    expect(
      textsOf(printed(PLAN, { columns: ['floats'] }).document.pages[0] ?? []).slice(15),
    ).toEqual(['Design', 'Near', 'Page 1 of 1']);
  });

  it('prints the chosen columns, the WBS before the names and the others after them in their usual order', () => {
    const texts = textsOf(
      printed(PLAN, { columns: [...PRINT_COLUMNS].reverse() }).document.pages[0] ?? [],
    );
    const headers = ['WBS', 'Name', 'Start', 'End', 'Duration', '%', 'Predecessors'];
    expect(texts.filter((value) => headers.includes(value))).toEqual(headers);
    expect(texts.slice(texts.indexOf('WBS'), texts.indexOf('Name'))).toEqual([
      'WBS',
      '1',
      '1.1',
      '1.2',
      '2',
      '3',
    ]);
    expect(texts.slice(texts.indexOf('%'), -3)).toEqual([
      '%',
      '17%',
      '50%',
      '0%',
      '0%',
      '0%',
      'Predecessors',
      '1.1',
      '1.2',
      '2',
    ]);
  });

  it('turns to a grid of pages for a long plan, each page repeating the scale and numbered among all pages', () => {
    const plan = printed(longPlan(60));
    expect(plan.layout.pageRows).toBe(3);
    expect(plan.document.pages).toHaveLength(plan.layout.pageColumns * 3);
    const firstRows = [1, 28, 55];
    plan.document.pages.forEach((page, index) => {
      const texts = textsOf(page);
      const first = firstRows[index] ?? 0;
      expect(texts.at(-1)).toBe(`Page ${String(index + 1)} of 3`);
      expect(texts.filter((text) => text === 'Name' || text === 'October 2026')).toEqual([
        'October 2026',
        'Name',
      ]);
      expect(texts.filter((text) => text.startsWith('Task '))).toEqual(
        Array.from(
          { length: Math.min(27, 61 - first) },
          (_unused, row) => `Task ${String(first + row)}`,
        ),
      );
    });
    expect(readPrintDocument(plan.document)).toEqual({ ok: true, value: plan.document });
  });

  it('lays a long and wide plan out as a grid read row of pages by row of pages, each page repeating the names of its row and the scale of its column', () => {
    const plan = printed(longPlan(60), { zoom: 'day' });
    expect([plan.layout.pageColumns, plan.layout.pageRows]).toEqual([3, 3]);
    const pages = plan.document.pages.map((page) => textsOf(page));
    /** Returns the labels of the time scale written on a page. */
    const scaleOf = (texts: readonly string[]) => texts.slice(2, texts.indexOf('Name'));
    expect(pages.map((texts) => scaleOf(texts).slice(0, 3))).toEqual([
      ...[1, 2, 3].flatMap(() => [
        ['September 2…', 'October 2026', '28'],
        ['October 2026', 'November 2026', '29'],
        ['Novembe…', 'December 2026', '29'],
      ]),
    ]);
    pages.forEach((texts, index) => {
      const first = 1 + Math.floor(index / 3) * 27;
      expect(scaleOf(texts)).toEqual(scaleOf(pages[index % 3] ?? []));
      expect(texts.filter((text) => text.startsWith('Task '))).toEqual(
        Array.from(
          { length: Math.min(27, 61 - first) },
          (_unused, row) => `Task ${String(first + row)}`,
        ),
      );
      expect(texts.at(-1)).toBe(`Page ${String(index + 1)} of 9`);
    });
  });

  it('prints a period before the plan with every name and the legend but no bar', () => {
    const start = dayIndexOf(PLAN.startDate);
    const plan = printed(PLAN, {
      period: { kind: 'days', firstDay: start - 30, lastDay: start - 20 },
    });
    const page = plan.document.pages[0] ?? [];
    const texts = textsOf(page);
    expect(plan.document.pages).toHaveLength(1);
    expect(texts.slice(texts.indexOf('Name'))).toEqual([
      'Name',
      'Research',
      'Survey',
      'Interviews',
      'Writing',
      'Defense',
      'Design',
      'Near',
      'Page 1 of 1',
    ]);
    const orders = flatten(page);
    expect(orders.filter((order) => order.kind === 'pattern')).toHaveLength(1);
    expect(
      orders.filter((order) => order.kind === 'fill' && order.color === '#2a78d6'),
    ).toHaveLength(1);
  });

  it('writes a legend of 40 tags on every page, in order of name, giving fewer rows to each page', () => {
    const tags = Array.from({ length: 40 }, (_unused, index) => ({
      id: testId(`g${String(index)}`),
      name: `Tag ${String(39 - index).padStart(2, '0')}`,
      color: '#2A78D6',
      representsPersonOrTeam: false,
    }));
    const tasks = Array.from({ length: 40 }, (_unused, index) =>
      workTask(`t${String(index)}`, {
        sortKey: `k${String(index).padStart(2, '0')}`,
        tagId: testId(`g${String(index)}`),
      }),
    );
    const plan = printed({ ...project(tasks, [], { tags }), name: 'Tagged' });
    expect([plan.layout.rowsPerPage, plan.document.pages.length]).toEqual([24, 2]);
    const legend = Array.from(
      { length: 40 },
      (_unused, index) => `Tag ${String(index).padStart(2, '0')}`,
    );
    plan.document.pages.forEach((page, index) => {
      expect(textsOf(page).slice(-41)).toEqual([...legend, `Page ${String(index + 1)} of 2`]);
    });
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
    expect(perBand).toEqual([1, 1, 1, 0]);
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

  it('ends the whole plan on the day before a last end that falls at midnight', () => {
    const evening = {
      ...project([workTask('a', { name: 'Night shift' })], []),
      calendar: { ...PLAN.calendar, workingTimeRanges: [{ startHour: 17, endHour: 24 }] },
    };
    const monday = dayIndexOf(evening.startDate);
    expect(scheduleOrThrow(evening).placements.get(testId('a'))?.end).toBe((monday + 1) * 24);
    expect(printed(evening).period).toEqual({ start: monday * 24, end: (monday + 1) * 24 });
  });

  it('prints a plan of decades in the automatic zoom by month over a row of pages, never narrower than its labels', () => {
    const decades = {
      ...project([workTask('a'), milestone('far', { startNoEarlierThan: at(2150, 1, 5, 9) })], []),
      name: 'Decades',
    };
    const plan = printed(decades, { zoom: 'automatic' });
    expect([plan.zoom, plan.layout.pageColumns, plan.layout.pageRows]).toEqual(['month', 49, 1]);
  });

  it('throws for a link to a task that has no printed row, which a checked plan never holds', () => {
    const source = sourceOf(PLAN);
    const broken = {
      ...source,
      project: { ...PLAN, dependencies: [...PLAN.dependencies, link('a', 'ghost')] },
    };
    expect(() => buildPrintDocument(broken, SETTINGS, measure)).toThrow(
      new RangeError('The linked task ghost has no printed row.'),
    );
  });

  it('keeps a chosen zoom and picks a legible one in the automatic zoom', () => {
    expect(printed(PLAN, { zoom: 'week' }).zoom).toBe('week');
    expect(printed(PLAN, { zoom: 'automatic' }).zoom).toBe('day');
    expect(printed(longPlan(400), { zoom: 'automatic' }).zoom).toBe('month');
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
            expect(readPrintDocument(result.value.document)).toEqual({
              ok: true,
              value: result.value.document,
            });
          },
        ),
        { numRuns: 40 },
      );
    },
  );
});
