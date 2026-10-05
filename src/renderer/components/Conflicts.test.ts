import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Tag } from '../../core/model/project';
import { at } from '../../core/testing/civil-time';
import { project, summary, workTask } from '../../core/testing/project-builder';
import { HOURS_PER_DAY } from '../../core/time';
import { AppState } from '../app/app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from '../app/testing/fake-app-context';
import { createPeriodFormatter } from '../i18n/format';
import english from '../locales/en.json';
import { pixelsPerHour } from '../plan/time-scale';
import { ROW_HEIGHT, timelineFrame, xOf } from '../plan/timeline-geometry';
import { localHourOf } from '../project/new-project';
import App from './App.svelte';
import { button, click, render, single, update } from './testing/render';
import { resize } from './testing/timeline-environment';

const TEXT = english.status;
const TODAY = new Date(2026, 8, 28, 10);
const FILLERS = 30;
const SCROLLER_HEIGHT = 340;
const ALICE: Tag = { id: 'alice', name: 'Alice', color: '#4a3aa7', representsPersonOrTeam: true };
const LATER = at(2026, 10, 19, 9);
const PLAN: Project = project(
  [
    ...Array.from({ length: FILLERS }, (_unused, index) =>
      workTask(`f${String(index).padStart(2, '0')}`, {
        sortKey: `a${String(index).padStart(2, '0')}`,
      }),
    ),
    workTask('interviews', {
      name: 'Interviews',
      tagId: 'alice',
      sortKey: 'b',
      startNoEarlierThan: LATER,
    }),
    workTask('analysis', {
      name: 'Analysis',
      tagId: 'alice',
      sortKey: 'c',
      startNoEarlierThan: LATER,
    }),
  ],
  [],
  { tags: [ALICE] },
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Renders the sized interface over a plan whose two tasks of Alice overlap far below and after the first rows. */
async function renderConflicts(plan: Project = PLAN) {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  fake.control.openResult = openedProjectOf(plan);
  await app.open();
  await settle();
  const root = render(App, { app });
  resize(single(root, 'main.workspace'), 1_200, 600);
  const scroller = single(root, '.scroller');
  resize(scroller, 800, SCROLLER_HEIGHT);
  update();
  return { app, root, scroller };
}

describe('the conflicts of people and teams', () => {
  it('show a count after the legend that opens the list, one line per period with its tasks', async () => {
    const { app, root } = await renderConflicts();
    const toggle = button(root, TEXT.conflicts.one.replace('{count}', '1'));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelectorAll('#conflict-list')).toHaveLength(0);
    click(toggle);
    update();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const conflict = app.schedule?.tagConflicts.conflicts[0];
    if (conflict === undefined) {
      throw new Error('No conflict');
    }
    const line = single(root, '#conflict-list .conflict');
    expect(single(line, 'strong').textContent).toBe('Alice');
    expect(single(line, '.when').textContent).toBe(
      createPeriodFormatter(app.locale)(conflict.start, conflict.end),
    );
    expect(single(line, '.tasks').textContent).toBe('Analysis and Interviews');
    click(button(root, TEXT.closeConflicts));
    update();
    expect(root.querySelectorAll('#conflict-list')).toHaveLength(0);
  });

  it('select the first task of a conflict and scroll the table and the timeline to its start', async () => {
    const { app, root, scroller } = await renderConflicts();
    click(button(root, TEXT.conflicts.one.replace('{count}', '1')));
    update();
    click(single(root, '#conflict-list .conflict'));
    update();
    const conflict = app.schedule?.tagConflicts.conflicts[0];
    const schedule = app.schedule;
    if (conflict === undefined || schedule === null) {
      throw new Error('No conflict');
    }
    expect(app.selectedTaskId).toBe('analysis');
    const row = app.outline.rowIndexById.get('analysis') ?? -1;
    expect(row).toBe(FILLERS + 1);
    expect(scroller.scrollTop).toBe((row + 1) * ROW_HEIGHT - SCROLLER_HEIGHT);
    const frame = timelineFrame(
      PLAN.startDate,
      schedule,
      localHourOf(TODAY),
      pixelsPerHour(app.zoom),
    );
    expect(scroller.scrollLeft).toBe(xOf(frame, conflict.start - 2 * HOURS_PER_DAY));
    expect(app.revealRequest).toBeNull();
  });

  it('show no count without a conflict', async () => {
    const { root } = await renderConflicts(project([workTask('a')], [], { tags: [ALICE] }));
    expect(root.querySelectorAll('.status-bar .conflicts')).toHaveLength(0);
  });

  it('open the summary that hides the first task of a conflict before scrolling to it', async () => {
    const hidden: Project = {
      ...PLAN,
      tasks: [
        ...PLAN.tasks.filter((task) => task.id !== 'analysis'),
        summary('group', { name: 'Group', sortKey: 'd' }),
        workTask('analysis', {
          name: 'Analysis',
          tagId: 'alice',
          parentId: 'group',
          sortKey: 'a',
          startNoEarlierThan: LATER,
        }),
      ],
    };
    const { app, root, scroller } = await renderConflicts(hidden);
    app.setSummaryOpen('group', false);
    update();
    expect(app.outline.rowIndexById.has('analysis')).toBe(false);
    click(button(root, TEXT.conflicts.one.replace('{count}', '1')));
    update();
    click(single(root, '#conflict-list .conflict'));
    update();
    const row = app.outline.rowIndexById.get('analysis') ?? -1;
    expect(row).toBe(FILLERS + 2);
    expect(scroller.scrollTop).toBe((row + 1) * ROW_HEIGHT - SCROLLER_HEIGHT);
  });

  it('count several conflicts in the plural, explain them, and give the focus back when the list closes', async () => {
    const bruno: Tag = { ...ALICE, id: 'bruno', name: 'Bruno', color: '#4a3aa8' };
    const two: Project = {
      ...PLAN,
      tags: [ALICE, bruno],
      tasks: [
        ...PLAN.tasks,
        workTask('writing', { name: 'Writing', tagId: 'bruno', sortKey: 'd' }),
        workTask('figures', { name: 'Figures', tagId: 'bruno', sortKey: 'e' }),
      ],
    };
    const { root } = await renderConflicts(two);
    const toggle = button(root, TEXT.conflicts.other.replace('{count}', '2'));
    expect(toggle.title).toBe(TEXT.conflictsHint);
    expect(
      [...root.querySelectorAll('.legend .swatch')].map((swatch) =>
        swatch.classList.contains('diagonal'),
      ),
    ).toEqual([false, true]);
    click(toggle);
    update();
    expect(root.querySelectorAll('#conflict-list .conflict')).toHaveLength(2);
    click(button(root, TEXT.closeConflicts));
    update();
    expect(document.activeElement).toBe(toggle);
  });
});
