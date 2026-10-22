import { describe, expect, it } from 'vitest';
import type { Project } from '../model/project';
import { computeWbsNumbers } from '../scheduling/wbs';
import { dayIndexOf, SATURDAY } from '../time';
import { project, PROJECT_START, TEST_DOCUMENT_ID, workTask } from '../testing/project-builder';
import { sessionOn } from '../testing/session-copy';
import { TEST_CALENDAR } from '../testing/test-calendar';
import { spreadKeys } from './fractional-index';
import { createSharedDocument } from './shared-document';
import type { SharedOperation } from './shared-operations';
import type { SharedSession } from './shared-session';

const FIRST_DAY = dayIndexOf(PROJECT_START);
const LEFT_PERIOD = { firstDay: FIRST_DAY + 7, lastDay: FIRST_DAY + 8 };
const RIGHT_PERIOD = { firstDay: FIRST_DAY + 14, lastDay: FIRST_DAY + 15 };
const SIBLING_IDS = ['a', 'b', 'c', 'd', 'e'];

/** Opens two people's sessions on the same plan, the second one having the larger Yjs client identifier. */
function twoPeople(base: Project = project(SIBLING_IDS.map((id) => workTask(id)))) {
  const origin = createSharedDocument(base, TEST_DOCUMENT_ID);
  return { left: sessionOn(origin, 1), right: sessionOn(origin, 2) };
}

/** Applies an operation that a test expects to be accepted. */
function apply(session: SharedSession, operation: SharedOperation): void {
  expect(session.apply(operation).ok).toBe(true);
}

/** Gives each of two sessions what the other changed, as the network would after they edited at the same time, returning the repairs each one made. */
function exchange(left: SharedSession, right: SharedSession) {
  const toRight = left.encodeState(right.encodeStateVector());
  const toLeft = right.encodeState(left.encodeStateVector());
  return [right.merge(toRight), left.merge(toLeft)];
}

describe('two people changing the same plan at the same time', () => {
  it('keeps both options when each person turns on a different one', () => {
    const { left, right } = twoPeople();
    const options = left.project().options;
    apply(left, {
      type: 'updateProject',
      fields: { options: { ...options, criticalPathEnabled: true } },
    });
    apply(right, {
      type: 'updateProject',
      fields: { options: { ...options, baselineEnabled: true } },
    });
    expect(exchange(left, right)).toEqual([
      { ok: true, value: [] },
      { ok: true, value: [] },
    ]);
    expect(left.project()).toEqual(right.project());
    expect(left.project().options).toEqual({
      ...options,
      criticalPathEnabled: true,
      baselineEnabled: true,
    });
  });

  it('keeps one of two non-working periods added at the same time, the calendar lists being written whole, the same one for both people', () => {
    const { left, right } = twoPeople();
    const calendar = left.project().calendar;
    apply(left, {
      type: 'updateProject',
      fields: { calendar: { ...calendar, nonWorkingPeriods: [LEFT_PERIOD] } },
    });
    apply(right, {
      type: 'updateProject',
      fields: { calendar: { ...calendar, nonWorkingPeriods: [RIGHT_PERIOD] } },
    });
    expect(exchange(left, right)).toEqual([
      { ok: true, value: [] },
      { ok: true, value: [] },
    ]);
    expect(left.project()).toEqual(right.project());
    expect(left.project().calendar.nonWorkingPeriods).toEqual([RIGHT_PERIOD]);
  });

  it('keeps one of two working days changed at the same time, the same one for both people', () => {
    const { left, right } = twoPeople();
    const calendar = left.project().calendar;
    apply(left, {
      type: 'updateProject',
      fields: {
        calendar: { ...calendar, workingWeekdays: [...calendar.workingWeekdays, SATURDAY] },
      },
    });
    apply(right, {
      type: 'updateProject',
      fields: { calendar: { ...calendar, workingWeekdays: calendar.workingWeekdays.slice(1) } },
    });
    expect(exchange(left, right)).toEqual([
      { ok: true, value: [] },
      { ok: true, value: [] },
    ]);
    expect(left.project()).toEqual(right.project());
    expect(left.project().calendar.workingWeekdays).toEqual(TEST_CALENDAR.workingWeekdays.slice(1));
  });

  it('gives both people the same valid order, mixing the two, when each renumbers the same siblings', () => {
    const { left, right } = twoPeople();
    const keys = spreadKeys(SIBLING_IDS.length);
    /** Renumbers every sibling of a session so that they follow a given order of identifiers. */
    const renumber = (session: SharedSession, order: readonly string[]): void => {
      const tasks = session.project().tasks;
      expect(
        session.applyAll(
          order.map((id, index) => {
            const task = tasks.find((candidate) => candidate.id === id);
            if (task === undefined) {
              throw new Error(`No task ${id}`);
            }
            return { type: 'putTask', task: { ...task, sortKey: keys[index] ?? '' } };
          }),
        ).ok,
      ).toBe(true);
    };
    renumber(left, ['e', 'd', 'c', 'b', 'a']);
    renumber(right, ['b', 'c', 'd', 'e', 'a']);
    expect(exchange(left, right)).toEqual([
      { ok: true, value: [] },
      { ok: true, value: [] },
    ]);
    expect(left.project()).toEqual(right.project());
    const tasks = left.project().tasks;
    expect(tasks.map((task) => [task.id, task.sortKey])).toEqual([
      ['a', keys[4]],
      ['b', keys[0]],
      ['c', keys[1]],
      ['d', keys[2]],
      ['e', keys[0]],
    ]);
    expect(Object.fromEntries(computeWbsNumbers(new Map([[null, tasks]])))).toEqual({
      b: '1',
      e: '2',
      c: '3',
      d: '4',
      a: '5',
    });
  });
});
