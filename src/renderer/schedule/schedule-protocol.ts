import type { Project } from '../../core/model/project';
import type { Result } from '../../core/result';
import type { Schedule, SchedulingFailure } from '../../core/scheduling/schedule-project';
import type { PackedKind } from './packed-schedule';
import type { DescriptionDelta, ProjectDelta, ScheduleDelta } from './schedule-changes';

export const SCHEDULE_PROTOCOL_VERSION = 3;

interface Numbered {
  readonly version: typeof SCHEDULE_PROTOCOL_VERSION;
  readonly generation: number;
}

export type ScheduleRequest =
  | (Numbered & { readonly kind: 'whole'; readonly project: Project })
  | (Numbered & {
      readonly kind: 'changes';
      readonly basis: number;
      readonly changes: ProjectDelta;
    });

export type ScheduleAnswer =
  | { readonly kind: 'whole'; readonly schedule: Schedule }
  | { readonly kind: 'changes'; readonly changes: ScheduleDelta };

export interface ScheduleResponse extends Numbered {
  readonly result: Result<ScheduleAnswer, SchedulingFailure>;
  readonly description: DescriptionDelta;
}

/** Tells whether a message is a schedule request of the current protocol version: a whole project, or the changes since the request of a given generation. */
export function isScheduleRequest(message: unknown): message is ScheduleRequest {
  if (!hasVersionAndGeneration(message)) {
    return false;
  }
  const kind: unknown = Reflect.get(message, 'kind');
  if (kind === 'whole') {
    return isObject(Reflect.get(message, 'project'));
  }
  const basis: unknown = Reflect.get(message, 'basis');
  return (
    kind === 'changes' && Number.isSafeInteger(basis) && isObject(Reflect.get(message, 'changes'))
  );
}

/** Tells whether a message is a schedule response of the current protocol version: a known failure, a whole schedule or its changes, and the changes of its conflicts, numbers, identifiers and line places being checked as they are applied. */
export function isScheduleResponse(message: unknown): message is ScheduleResponse {
  if (!hasVersionAndGeneration(message) || !holdsDescription(Reflect.get(message, 'description'))) {
    return false;
  }
  const result: unknown = Reflect.get(message, 'result');
  const ok: unknown = Reflect.get(Object(result), 'ok');
  if (ok === false) {
    const error: unknown = Reflect.get(Object(result), 'error');
    const kind: unknown = Reflect.get(Object(error), 'kind');
    return typeof kind === 'string' && Object.hasOwn(FAILURE_KINDS, kind);
  }
  return ok === true && holdsAnswer(Reflect.get(Object(result), 'value'));
}

/** Tells whether a value is a whole schedule or the changes of one. */
function holdsAnswer(value: unknown): boolean {
  const kind: unknown = Reflect.get(Object(value), 'kind');
  if (kind === 'whole') {
    return holdsSchedule(Reflect.get(Object(value), 'schedule'));
  }
  return kind === 'changes' && holdsScheduleDelta(Reflect.get(Object(value), 'changes'));
}

/** Tells whether a value holds every field of the changes of a schedule. */
function holdsScheduleDelta(value: unknown): boolean {
  const floats: unknown = Reflect.get(Object(value), 'floats');
  const conflicts: unknown = Reflect.get(Object(value), 'conflicts');
  const tagConflicts: unknown = Reflect.get(Object(value), 'tagConflicts');
  return (
    holdsPacked(Reflect.get(Object(value), 'placements'), 'placements') &&
    NUMBERED_TABLES.every((table) => holdsMapDelta(Reflect.get(Object(value), table))) &&
    holdsFloatsDelta(floats) &&
    (conflicts === null || Array.isArray(conflicts)) &&
    holdsTagConflictsDelta(tagConflicts)
  );
}

/** Tells whether a value holds the changes of the report on tags: none, the whole report, or the times of its conflicts. */
function holdsTagConflictsDelta(value: unknown): boolean {
  const kind: unknown = Reflect.get(Object(value), 'kind');
  return (
    kind === 'same' ||
    (kind === 'whole' && holdsTagReport(Reflect.get(Object(value), 'report'))) ||
    (kind === 'times' && Reflect.get(Object(value), 'times') instanceof Float64Array)
  );
}

/** Tells whether a value holds packed entries of a kind: their identifiers, their numbers and the identifiers removed, the numbers being read and checked as they are applied. */
function holdsPacked(value: unknown, kind: PackedKind): boolean {
  return (
    Reflect.get(Object(value), 'kind') === kind &&
    Array.isArray(Reflect.get(Object(value), 'ids')) &&
    Reflect.get(Object(value), 'numbers') instanceof Float64Array &&
    Array.isArray(Reflect.get(Object(value), 'removed'))
  );
}

/** Tells whether a value holds the changes of the floats of a schedule. */
function holdsFloatsDelta(value: unknown): boolean {
  const kind: unknown = Reflect.get(Object(value), 'kind');
  const floats: unknown = Reflect.get(Object(value), 'floats');
  return (
    kind === 'same' ||
    (kind === 'whole' && (floats === null || floats instanceof Map)) ||
    (kind === 'changes' && holdsPacked(Reflect.get(Object(value), 'changes'), 'floats'))
  );
}

/** Tells whether a value holds the entries to put and the keys to remove of a table. */
function holdsMapDelta(value: unknown): boolean {
  return (
    Array.isArray(Reflect.get(Object(value), 'put')) &&
    Array.isArray(Reflect.get(Object(value), 'removed'))
  );
}

/** Tells whether a value holds what changed in each part of the description of the conflicts: all its lines or the error that kept them from being described, its lines changed by position, or for people the times of their conflicts alone. */
function holdsDescription(value: unknown): boolean {
  return (['people', 'dates'] as const).every((part) => {
    const delta: unknown = Reflect.get(Object(value), part);
    const kind: unknown = Reflect.get(Object(delta), 'kind');
    if (kind === 'times') {
      return part === 'people' && Reflect.get(Object(delta), 'times') instanceof Float64Array;
    }
    if (kind === 'changes') {
      return (
        Number.isSafeInteger(Reflect.get(Object(delta), 'length')) &&
        Array.isArray(Reflect.get(Object(delta), 'put'))
      );
    }
    const lines: unknown = Reflect.get(Object(delta), 'lines');
    const ok: unknown = Reflect.get(Object(lines), 'ok');
    return (
      kind === 'whole' &&
      (ok === true
        ? Array.isArray(Reflect.get(Object(lines), 'value'))
        : ok === false && isObject(lines) && Object.hasOwn(lines, 'error'))
    );
  });
}

/** Tells whether a value holds every field of a schedule: its tables, its floats when computed, its conflicts and the report of its tags. */
function holdsSchedule(value: unknown): boolean {
  const floats: unknown = Reflect.get(Object(value), 'floats');
  const tagConflicts: unknown = Reflect.get(Object(value), 'tagConflicts');
  return (
    SCHEDULE_TABLES.every((table) => Reflect.get(Object(value), table) instanceof Map) &&
    (floats === null || floats instanceof Map) &&
    Array.isArray(Reflect.get(Object(value), 'conflicts')) &&
    holdsTagReport(tagConflicts)
  );
}

/** Tells whether a value holds the conflicts and the tasks with an unknown tag of a report on tags. */
function holdsTagReport(value: unknown): boolean {
  return (
    Array.isArray(Reflect.get(Object(value), 'conflicts')) &&
    Array.isArray(Reflect.get(Object(value), 'tasksWithUnknownTag'))
  );
}

const SCHEDULE_TABLES = ['placements', 'summaries', 'wbsNumbers'] as const;
const NUMBERED_TABLES = ['summaries', 'wbsNumbers'] as const;
const FAILURE_KINDS = {
  calendar: true,
  startDate: true,
  structure: true,
  task: true,
} as const satisfies Readonly<Record<SchedulingFailure['kind'], true>>;

/** Tells whether a message carries the current protocol version and a whole generation number. */
function hasVersionAndGeneration(
  message: unknown,
): message is { readonly version: number; readonly generation: number } {
  return (
    typeof message === 'object' &&
    message !== null &&
    'version' in message &&
    message.version === SCHEDULE_PROTOCOL_VERSION &&
    'generation' in message &&
    Number.isSafeInteger(message.generation)
  );
}

/** Tells whether a value is an object other than null. */
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
