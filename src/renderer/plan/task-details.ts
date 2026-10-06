import { formatDateTime } from '../../core/civil-format';
import { compareStrings } from '../../core/compare-strings';
import type {
  Project,
  ProjectOptions,
  Task,
  TagId,
  TaskId,
  TaskSegment,
} from '../../core/model/project';
import { failure, success, type Result } from '../../core/result';
import { HOURS_PER_DAY, QUARTER_HOUR, type ProjectHour } from '../../core/time';
import { formatTimeOfDay, parseTimeOfDay } from './time-of-day';
import { hourFromPicker } from './cell-editing';
import { durationEditorText, parseDuration } from './durations';
import type { EditError } from './task-commands';

export interface BlockDraft {
  readonly duration: string;
  readonly gapDays: string;
  readonly start: string;
  readonly origin: number | null;
  readonly waitsFor: string;
}

export interface TaskDraft {
  readonly name: string;
  readonly tagId: TagId | null;
  readonly progress: string;
  readonly start: string;
  readonly mustFinishOn: string;
  readonly deadline: string;
  readonly hoursPerDay: string;
  readonly dailyStart: string;
  readonly blocks: readonly BlockDraft[];
  readonly basis: string;
}

export type DetailsError =
  | EditError
  | 'INVALID_BLOCK'
  | 'INVALID_GAP'
  | 'INVALID_HOURS_PER_DAY'
  | 'INVALID_DAILY_START'
  | 'INVALID_MUST_FINISH_ON'
  | 'INVALID_DEADLINE';

const PROGRESS_PATTERN = /^\d{1,3}$/;
const GAP_PATTERN = /^\d{1,4}$/;
const MAX_PROGRESS = 100;
const MIN_GAP_DAYS = 0;
const ADDED_BLOCK_GAP_DAYS = 1;
const MIN_HOURS_PER_DAY = 1;
const DECIMAL_RADIX = 10;
const DATE_TIME_SEPARATOR = 'T';
const EMPTY_DRAFT: TaskDraft = {
  name: '',
  tagId: null,
  progress: '0',
  start: '',
  mustFinishOn: '',
  deadline: '',
  hoursPerDay: '',
  dailyStart: '',
  blocks: [],
  basis: '',
};

/** Fills the fields of the details panel from a task, with what each of its blocks waits for written as in the task table and the description of the task it was opened on. */
export function draftFromTask(
  task: Task,
  waitsFor: (block: number) => string,
  basis: string,
): TaskDraft {
  if (task.kind === 'summary') {
    return { ...EMPTY_DRAFT, name: task.name, basis };
  }
  const common = {
    name: task.name,
    tagId: task.tagId,
    progress: String(task.progressPercent),
    start: pickerText(task.startNoEarlierThan),
    mustFinishOn: pickerText(task.mustFinishOn),
    deadline: pickerText(task.deadline),
  };
  if (task.kind === 'milestone') {
    return { ...EMPTY_DRAFT, ...common, basis };
  }
  return {
    ...common,
    basis,
    hoursPerDay: task.hoursPerDay === null ? '' : durationEditorText(task.hoursPerDay),
    dailyStart: task.dailyStartHour === null ? '' : formatTimeOfDay(task.dailyStartHour),
    blocks: task.segments.map((segment, block) => ({
      duration: durationEditorText(segment.durationHours),
      gapDays: String(segment.gapDaysBefore),
      start: pickerText(segment.startNoEarlierThan),
      origin: block,
      waitsFor: waitsFor(block),
    })),
  };
}

/** Describes a task, the links that touch it and whether its date constraints are shown, in an order that does not depend on the project, so that two descriptions differ only when one of them changed. */
export function taskBasis(project: Project, id: TaskId): string {
  const task = project.tasks.find((candidate) => candidate.id === id);
  const links = project.dependencies
    .filter((link) => link.predecessorId === id || link.successorId === id)
    .sort((left, right) => compareStrings(left.id, right.id));
  return JSON.stringify([task, links, project.options.dateConstraintsEnabled]);
}

/** Builds the task the details panel asks for, reading every field shown and keeping the date constraints unchanged while they are turned off, or tells which field cannot be read. */
export function taskFromDraft(
  task: Task,
  draft: TaskDraft,
  dayHours: number,
  options: ProjectOptions,
): Result<Task, DetailsError> {
  const name = draft.name.trim();
  if (name === '') {
    return failure('INVALID_NAME');
  }
  if (task.kind === 'summary') {
    return success({ ...task, name });
  }
  const progress = readProgress(draft.progress);
  const start = readPickerInstant(draft.start);
  if (progress === null) {
    return failure('INVALID_PROGRESS');
  }
  if (start === undefined) {
    return failure('INVALID_DATE');
  }
  const constraints = options.dateConstraintsEnabled ? readConstraints(draft) : success({});
  if (!constraints.ok) {
    return constraints;
  }
  const dated = {
    ...task,
    name,
    tagId: draft.tagId,
    progressPercent: progress,
    startNoEarlierThan: start,
    ...constraints.value,
  };
  if (dated.kind === 'milestone') {
    return success(dated);
  }
  const pattern = readDailyPattern(draft, dayHours);
  if (!pattern.ok) {
    return pattern;
  }
  const segments = readBlocks(draft.blocks, pattern.value.hoursPerDay ?? dayHours);
  return segments.ok ? success({ ...dated, ...pattern.value, segments: segments.value }) : segments;
}

/** Returns the blocks of a draft with one more block of a working day, a day after the last one, waiting for nothing. */
export function withAddedBlock(draft: TaskDraft, dayHours: number): TaskDraft {
  const block = {
    duration: durationEditorText(dayHours),
    gapDays: String(ADDED_BLOCK_GAP_DAYS),
    start: '',
    origin: null,
    waitsFor: '',
  };
  return { ...draft, blocks: [...draft.blocks, block] };
}

/** Returns the blocks of a draft without the block at an index, the first block always keeping no gap and no start date of its own, the task keeping the later of its start date and the one that block had. */
export function withoutBlock(draft: TaskDraft, index: number): TaskDraft {
  if (draft.blocks.length <= 1) {
    return draft;
  }
  const blocks = draft.blocks.filter((_block, position) => position !== index);
  return {
    ...draft,
    start: laterStart(draft.start, blocks[0]?.start ?? ''),
    blocks: blocks.map((block, position) =>
      position === 0 ? { ...block, gapDays: '0', start: '' } : block,
    ),
  };
}

/** Returns the index of the first later block whose start date cannot be read, or null, so that the details panel can tell which field to fix. */
export function findUnreadableBlockStart(draft: TaskDraft): number | null {
  const index = draft.blocks.findIndex(
    (block, position) => position > 0 && readPickerInstant(block.start) === undefined,
  );
  return index < 0 ? null : index;
}

/** Returns the later of two start dates written in pickers, keeping the first one when either cannot be read so that saving reports it. */
function laterStart(taskStart: string, blockStart: string): string {
  const task = readPickerInstant(taskStart);
  const block = readPickerInstant(blockStart);
  if (block === null || block === undefined || task === undefined) {
    return taskStart;
  }
  return task === null || block > task ? blockStart : taskStart;
}

/** Writes an optional instant as a date and time picker expects it, empty meaning none. */
function pickerText(hour: ProjectHour | null): string {
  return hour === null ? '' : formatDateTime(hour);
}

/** Reads the optional "must finish on" date and deadline of a task, or tells which one cannot be read. */
function readConstraints(
  draft: TaskDraft,
): Result<
  { readonly mustFinishOn: ProjectHour | null; readonly deadline: ProjectHour | null },
  DetailsError
> {
  const mustFinishOn = readPickerInstant(draft.mustFinishOn);
  if (mustFinishOn === undefined) {
    return failure('INVALID_MUST_FINISH_ON');
  }
  const deadline = readPickerInstant(draft.deadline);
  return deadline === undefined ? failure('INVALID_DEADLINE') : success({ mustFinishOn, deadline });
}

/** Reads a whole progress from 0 to 100, or null. */
function readProgress(text: string): number | null {
  const trimmed = text.trim();
  const value = PROGRESS_PATTERN.test(trimmed)
    ? Number.parseInt(trimmed, DECIMAL_RADIX)
    : Number.NaN;
  return value >= 0 && value <= MAX_PROGRESS ? value : null;
}

/** Reads an optional instant from a date and time picker, null meaning none and undefined an unreadable date. */
function readPickerInstant(text: string): ProjectHour | null | undefined {
  if (text.trim() === '') {
    return null;
  }
  return hourFromPicker(text.trim().replace(' ', DATE_TIME_SEPARATOR)) ?? undefined;
}

/** Reads the optional hours per day of a work task, and its daily start time, kept only when it works less than a whole working day. */
function readDailyPattern(
  draft: TaskDraft,
  dayHours: number,
): Result<
  { readonly hoursPerDay: number | null; readonly dailyStartHour: number | null },
  DetailsError
> {
  const written = draft.hoursPerDay.trim();
  const hoursPerDay = written === '' ? null : parseDuration(written, HOURS_PER_DAY);
  if (written !== '' && (hoursPerDay === null || hoursPerDay < MIN_HOURS_PER_DAY)) {
    return failure('INVALID_HOURS_PER_DAY');
  }
  const partDay = hoursPerDay !== null && hoursPerDay < dayHours;
  const dailyStartHour = partDay ? readTime(draft.dailyStart) : null;
  if (dailyStartHour === undefined) {
    return failure('INVALID_DAILY_START');
  }
  return success({ hoursPerDay, dailyStartHour });
}

/** Reads an optional time of day written as "HH:MM", on a quarter hour, null meaning none and undefined an unreadable time. */
function readTime(text: string): number | null | undefined {
  return text.trim() === '' ? null : (parseTimeOfDay(text) ?? undefined);
}

/** Reads the blocks of a work task: a duration each, and a gap of whole days and an optional start date for every block after the first. */
function readBlocks(
  blocks: readonly BlockDraft[],
  dayHours: number,
): Result<TaskSegment[], DetailsError> {
  const segments: TaskSegment[] = [];
  for (const [index, block] of blocks.entries()) {
    const durationHours = parseDuration(block.duration, dayHours);
    if (durationHours === null || durationHours < QUARTER_HOUR) {
      return failure('INVALID_BLOCK');
    }
    const gap = index === 0 ? 0 : readGap(block.gapDays);
    if (gap === null) {
      return failure('INVALID_GAP');
    }
    const start = index === 0 ? null : readPickerInstant(block.start);
    if (start === undefined) {
      return failure('INVALID_DATE');
    }
    segments.push({ durationHours, gapDaysBefore: gap, startNoEarlierThan: start });
  }
  return segments.length === 0 ? failure('INVALID_BLOCK') : success(segments);
}

/** Reads a gap of whole days between two blocks, zero meaning the same day, or null. */
function readGap(text: string): number | null {
  const trimmed = text.trim();
  const value = GAP_PATTERN.test(trimmed) ? Number.parseInt(trimmed, DECIMAL_RADIX) : Number.NaN;
  return value >= MIN_GAP_DAYS ? value : null;
}
