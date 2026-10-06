import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../core/model/project';
import { at } from '../../core/testing/civil-time';
import { link, milestone, project, summary, workTask } from '../../core/testing/project-builder';
import { AppState } from '../app/app-state.svelte';
import { fakeAppContext, openedProjectOf, settle } from '../app/testing/fake-app-context';
import { createMomentFormatter } from '../i18n/format';
import english from '../locales/en.json';
import { toggleProjectOption } from '../plan/project-commands';
import { pixelsPerHour } from '../plan/time-scale';
import { MILESTONE_SIZE, ROW_HEIGHT, timelineFrame, xOf } from '../plan/timeline-geometry';
import { localHourOf } from '../project/new-project';
import { SAND_GRAPHITE } from '../theme/sand-graphite';
import App from './App.svelte';
import { pixels } from './css-length';
import TaskDetails from './TaskDetails.svelte';
import { button, click, render, single, update } from './testing/render';
import { drawFrames, resize } from './testing/timeline-environment';

const STATUS = english.status;
const DETAILS = english.details;
const TODAY = new Date(2026, 8, 28, 8);
const DEADLINE = at(2026, 9, 28, 12);
const MUST_FINISH_ON = at(2026, 9, 28, 10);
const WRITING_END = at(2026, 9, 28, 17);
const DEFENSE_DEADLINE = at(2027, 1, 15, 9);
const HOURS_SHOWN_BEFORE = 48;
const PLAN: Project = project(
  [
    summary('s', { name: 'Study', sortKey: 'a' }),
    workTask('writing', { name: 'Writing', parentId: 's', sortKey: 'a', deadline: DEADLINE }),
    milestone('defense', {
      name: 'Defense',
      sortKey: 'b',
      mustFinishOn: MUST_FINISH_ON,
      deadline: DEFENSE_DEADLINE,
    }),
    workTask('free', { name: 'Free', sortKey: 'c' }),
  ],
  [link('writing', 'defense')],
  {
    options: {
      criticalPathEnabled: false,
      dateConstraintsEnabled: true,
      baselineEnabled: false,
      alwaysShowPatterns: false,
    },
  },
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Renders the sized interface over a plan, by default one where Writing misses its deadline and Defense cannot finish on its date. */
async function renderPlan(plan: Project = PLAN) {
  const fake = fakeAppContext();
  const app = new AppState(fake.context);
  fake.control.openResult = openedProjectOf(plan);
  await app.open();
  await settle();
  const root = render(App, { app });
  resize(single(root, 'main.workspace'), 1_200, 600);
  const scroller = single(root, '.scroller');
  resize(scroller, 800, 340);
  update();
  return { app, root, scroller };
}

/** Returns the period the timeline of the open project covers. */
function frameOf(app: AppState) {
  const opened = app.project;
  if (opened === null) {
    throw new Error('No project');
  }
  return timelineFrame(
    opened.startDate,
    app.schedule,
    localHourOf(TODAY),
    pixelsPerHour(app.zoom),
    app.shownDeadlines,
  );
}

/** Turns the date constraints of the open project off or on again. */
async function toggleDateConstraints(app: AppState): Promise<void> {
  expect(
    app.editSettings((context) => toggleProjectOption(context, 'dateConstraintsEnabled')),
  ).toBeNull();
  await settle();
  update();
}

describe('the dates tasks do not meet', () => {
  it('are counted with the other conflicts and listed in their own part, one line per date', async () => {
    const { app, root } = await renderPlan();
    const toggle = button(root, STATUS.conflicts.other.replace('{count}', '2'));
    expect(toggle.title).toBe(STATUS.conflictsHint);
    click(toggle);
    update();
    const list = single(root, '#conflict-list');
    expect([...list.querySelectorAll('h3')].map((heading) => heading.textContent)).toEqual([
      `${STATUS.dateConflicts}${STATUS.dateConflictsHint}`,
    ]);
    const moment = createMomentFormatter(app.locale);
    const lines = [...list.querySelectorAll('.conflict')].map((line) => [
      single(line, 'strong').textContent,
      single(line, '.when').textContent,
      single(line, '.tasks').textContent.trim(),
    ]);
    expect(lines).toEqual([
      [
        'Writing',
        STATUS.deadlineMissed,
        `Ends ${moment(WRITING_END)} · deadline ${moment(DEADLINE)}`,
      ],
      [
        'Defense',
        STATUS.mustFinishOnNotMet,
        `Ends ${moment(WRITING_END)} · must finish on ${moment(MUST_FINISH_ON)}`,
      ],
    ]);
  });

  it('lead to the task when a line is clicked, scrolling the timeline to its end', async () => {
    const { app, root, scroller } = await renderPlan();
    app.setSummaryOpen('s', false);
    click(button(root, STATUS.conflicts.other.replace('{count}', '2')));
    update();
    const writing = [...root.querySelectorAll<HTMLElement>('#conflict-list .conflict')][0];
    if (writing === undefined) {
      throw new Error('No line for Writing');
    }
    click(writing);
    update();
    expect([app.selectedTaskId, app.collapsed.has('s')]).toEqual(['writing', false]);
    expect(scroller.scrollLeft).toBe(xOf(frameOf(app), WRITING_END - HOURS_SHOWN_BEFORE));
    expect(app.revealRequest).toBeNull();
  });

  it('list the people and teams first, each part with its title', async () => {
    const alice = { id: 'alice', name: 'Alice', color: '#4a3aa7', representsPersonOrTeam: true };
    const busy: Project = {
      ...PLAN,
      tags: [alice],
      tasks: [
        ...PLAN.tasks,
        workTask('one', { name: 'One', sortKey: 'd', tagId: 'alice' }),
        workTask('two', { name: 'Two', sortKey: 'e', tagId: 'alice' }),
      ],
    };
    const { root } = await renderPlan(busy);
    click(button(root, STATUS.conflicts.other.replace('{count}', '3')));
    update();
    expect(
      [...root.querySelectorAll('#conflict-list h3')].map((heading) => heading.textContent),
    ).toEqual([
      `${STATUS.peopleConflicts}${STATUS.peopleConflictsHint}`,
      `${STATUS.dateConflicts}${STATUS.dateConflictsHint}`,
    ]);
    expect(root.querySelectorAll('#conflict-list .conflict')).toHaveLength(3);
  });

  it('mark only the end cell of each task, in red with an icon and a tooltip', async () => {
    const { app, root } = await renderPlan();
    const moment = createMomentFormatter(app.locale);
    const writing = single(root, '#cell-writing-end');
    expect(writing.classList.contains('late')).toBe(true);
    expect(writing.title).toBe(
      `Ends at ${moment(WRITING_END)}, after its deadline (${moment(DEADLINE)}).`,
    );
    const row = writing.closest('[role="row"]');
    if (row === null) {
      throw new Error('No row');
    }
    expect(
      [...row.querySelectorAll<HTMLElement>('[role="gridcell"]')]
        .filter((cell) => cell.title !== '' || cell.classList.contains('late'))
        .map((cell) => cell.id),
    ).toEqual(['cell-writing-end']);
    expect(writing.querySelectorAll('svg.icon')).toHaveLength(2);
    const defense = single(root, '#cell-defense-end');
    expect(defense.title).toBe(
      `Cannot finish on ${moment(MUST_FINISH_ON)}: it ends at ${moment(WRITING_END)} at the earliest.`,
    );
    const free = single(root, '#cell-free-end');
    expect([free.classList.contains('late'), free.title]).toEqual([false, '']);
    expect(free.querySelectorAll('svg.icon')).toHaveLength(1);
  });

  it('show the deadline key while deadlines are shown, and disappear with the option', async () => {
    const { app, root } = await renderPlan();
    const key = () =>
      [...root.querySelectorAll('.status-bar .deadline-key')].map((item) =>
        item.textContent.trim(),
      );
    expect(key()).toEqual([STATUS.deadline]);
    expect(single(root, '.status-bar .deadline-key').title).toBe(STATUS.deadlineHint);
    await toggleDateConstraints(app);
    expect(key()).toEqual([]);
    expect(root.querySelectorAll('.status-bar .conflicts')).toHaveLength(0);
    expect(root.querySelectorAll('.late')).toHaveLength(0);
  });

  it('show no deadline key when no task has a deadline', async () => {
    const { root } = await renderPlan(
      project([workTask('free', { name: 'Free' })], [], { options: PLAN.options }),
    );
    expect(root.querySelectorAll('.status-bar .deadline-key')).toHaveLength(0);
  });

  it('give one line and one tooltip sentence for each date a task misses', async () => {
    const both: Project = {
      ...PLAN,
      tasks: [
        ...PLAN.tasks,
        workTask('both', {
          name: 'Both',
          sortKey: 'd',
          deadline: DEADLINE,
          mustFinishOn: DEADLINE,
        }),
      ],
    };
    const { app, root } = await renderPlan(both);
    const moment = createMomentFormatter(app.locale);
    const end = app.schedule?.placements.get('both')?.end ?? Number.NaN;
    click(button(root, STATUS.conflicts.other.replace('{count}', '4')));
    update();
    expect(
      [...root.querySelectorAll('#conflict-list .conflict')]
        .slice(2)
        .map((line) => [single(line, 'strong').textContent, single(line, '.when').textContent]),
    ).toEqual([
      ['Both', STATUS.deadlineMissed],
      ['Both', STATUS.mustFinishOnNotMet],
    ]);
    const cell = single(root, '#cell-both-end');
    expect(cell.title).toBe(
      `Ends at ${moment(end)}, after its deadline (${moment(DEADLINE)}). ` +
        `Cannot finish on ${moment(DEADLINE)}: it ends at ${moment(end)} at the earliest.`,
    );
    expect(cell.querySelectorAll('svg.icon')).toHaveLength(2);
  });

  it('draw each deadline on the timeline, red only when missed, and outline the tasks and milestones that miss a date', async () => {
    const { app } = await renderPlan();
    const frame = frameOf(app);
    const rowTop = (id: string) => (app.outline.rowIndexById.get(id) ?? -1) * ROW_HEIGHT;
    const marksOf = (calls: ReturnType<typeof drawFrames>) =>
      calls
        .filter(
          (call) =>
            call.name === 'fillRect' && call.args[2] === 2 && call.args[3] === ROW_HEIGHT - 4,
        )
        .map((call) => [call.args[0], call.args[1], call.fillStyle]);
    const redStrokes = (calls: ReturnType<typeof drawFrames>) =>
      calls.filter(
        (call) =>
          call.name === 'stroke' &&
          call.strokeStyle === SAND_GRAPHITE.error &&
          call.lineWidth === 2,
      );
    const drawn = drawFrames();
    expect(marksOf(drawn)).toEqual([
      [xOf(frame, DEADLINE) - 1, rowTop('writing') + 2, SAND_GRAPHITE.error],
      [xOf(frame, DEFENSE_DEADLINE) - 1, rowTop('defense') + 2, SAND_GRAPHITE.action],
    ]);
    expect(redStrokes(drawn)).toHaveLength(2);
    const defenseX = xOf(frame, app.schedule?.placements.get('defense')?.start ?? Number.NaN);
    const reach = MILESTONE_SIZE / 2 + 2;
    expect(
      drawn.some(
        (call) =>
          call.name === 'moveTo' &&
          call.args[0] === defenseX &&
          call.args[1] === rowTop('defense') + ROW_HEIGHT / 2 - reach,
      ),
    ).toBe(true);
    await toggleDateConstraints(app);
    const plain = drawFrames();
    expect([marksOf(plain), redStrokes(plain)]).toEqual([[], []]);
  });

  it('widen the timeline to the deadlines only while date constraints are on', async () => {
    const { app, root } = await renderPlan();
    const spacer = () => single(root, '.scroller .spacer').style.width;
    const withDeadlines = frameOf(app);
    expect(withDeadlines.end).toBe(at(2027, 2, 14));
    expect(spacer()).toBe(pixels(xOf(withDeadlines, withDeadlines.end)));
    await toggleDateConstraints(app);
    const without = frameOf(app);
    expect(app.shownDeadlines).toEqual([]);
    expect(without.end).toBeLessThan(withDeadlines.end);
    expect(spacer()).toBe(pixels(xOf(without, without.end)));
  });
});

describe('the date constraints of the details panel', () => {
  /** Renders the details panel over the plan and opens it on a task. */
  async function detailsOf(id: string, plan: Project = PLAN) {
    const fake = fakeAppContext();
    const app = new AppState(fake.context);
    fake.control.openResult = openedProjectOf(plan);
    await app.open();
    if (app.project === null) {
      throw new Error('No project');
    }
    const root = render(TaskDetails, { app, project: app.project });
    app.openDetails(id);
    update();
    return { app, root };
  }

  /** Returns the values of the date fields of the open panel by their label, or nothing when the frame is hidden. */
  function constraintFields(root: HTMLElement): Record<string, string> {
    const frame = root.querySelector('fieldset.constraints');
    if (frame === null) {
      return {};
    }
    return Object.fromEntries(
      [...frame.querySelectorAll('label')].map((label): [string, string] => [
        label.querySelector('span')?.textContent ?? '',
        label.querySelector('input')?.value ?? '',
      ]),
    );
  }

  it('shows both dates of a task or a milestone in their own frame', async () => {
    const { root } = await detailsOf('writing');
    expect(single(root, 'fieldset.constraints legend').textContent).toBe(DETAILS.dateConstraints);
    expect(constraintFields(root)).toEqual({
      [DETAILS.mustFinishOn]: '',
      [DETAILS.deadline]: '2026-09-28T12:00',
    });
    const milestonePanel = await detailsOf('defense');
    expect(constraintFields(milestonePanel.root)).toEqual({
      [DETAILS.mustFinishOn]: '2026-09-28T10:00',
      [DETAILS.deadline]: '2027-01-15T09:00',
    });
  });

  it('saves the date a task must finish on from the panel', async () => {
    const { app, root } = await detailsOf('free');
    const input = [...root.querySelectorAll('fieldset.constraints label')]
      .find((label) => label.querySelector('span')?.textContent === DETAILS.mustFinishOn)
      ?.querySelector('input');
    if (input === null || input === undefined) {
      throw new Error('No field');
    }
    input.value = '2026-10-02T15:00';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    update();
    single(root, 'form').dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(app.project?.tasks.find((task) => task.id === 'free')).toMatchObject({
      mustFinishOn: at(2026, 10, 2, 15),
      deadline: null,
    });
  });

  it('hides the frame for a summary and while date constraints are turned off', async () => {
    expect((await detailsOf('s')).root.querySelector('fieldset.constraints')).toBeNull();
    const off = { ...PLAN, options: { ...PLAN.options, dateConstraintsEnabled: false } };
    expect((await detailsOf('writing', off)).root.querySelector('fieldset.constraints')).toBeNull();
  });
});
