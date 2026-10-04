import type { CalendarErrorCode } from '../../core/calendar/compile-calendar';
import type { StructureError, StructureErrorCode } from '../../core/scheduling/project-structure';
import type { SchedulingFailure } from '../../core/scheduling/schedule-project';
import type { PlacementErrorCode } from '../../core/scheduling/task-placement';
import type { TaskId } from '../../core/model/project';
import { fillMessage, type Messages } from './messages';

type ReasonCode = CalendarErrorCode | StructureErrorCode | PlacementErrorCode;

export interface ScheduleFailureText {
  readonly text: string;
  readonly entries: readonly string[];
}

const COUNTED_FROM_ONE = 1;

/** Explains why a schedule could not be computed, with one entry per problem found, naming the tasks concerned when they exist. */
export function scheduleFailureText(
  messages: Messages,
  failure: SchedulingFailure,
  taskName: (id: TaskId) => string | null,
): ScheduleFailureText {
  const texts = messages.scheduleFailures;
  switch (failure.kind) {
    case 'calendar':
      return {
        text: texts.calendar,
        entries: failure.errors.map((error) => reasonOf(messages, error.code)),
      };
    case 'startDate':
      return { text: texts.startDate, entries: [] };
    case 'structure':
      return {
        text: texts.structure,
        entries: failure.errors.map((error) => structureEntry(messages, error, taskName)),
      };
    case 'task':
      return {
        text: fillMessage(texts.task, {
          name: taskName(failure.error.taskId) ?? failure.error.taskId,
        }),
        entries: [reasonOf(messages, failure.error.code)],
      };
  }
}

/** Returns the text of a problem that stops the scheduling, every such code having one. */
function reasonOf(messages: Messages, code: ReasonCode): string {
  const reasons: Readonly<Record<ReasonCode, string>> = messages.issues;
  return reasons[code];
}

/** Writes a problem of the structure of the plan, placed on its task, link or tag when it has one. */
function structureEntry(
  messages: Messages,
  error: StructureError,
  taskName: (id: TaskId) => string | null,
): string {
  const reason = reasonOf(messages, error.code);
  if (!('list' in error)) {
    return reason;
  }
  const places = messages.issuePlaces;
  const number = String(error.index + COUNTED_FROM_ONE);
  const place =
    error.list === 'tasks'
      ? namedTask(messages, taskName(error.taskId), number)
      : fillMessage(error.list === 'dependencies' ? places.link : places.tag, { number });
  return fillMessage(places.placed, { place, reason });
}

/** Names a task by its name when it is found in the project, or by its position. */
function namedTask(messages: Messages, name: string | null, number: string): string {
  const places = messages.issuePlaces;
  return name === null
    ? fillMessage(places.task, { number })
    : fillMessage(places.taskNamed, { name });
}
