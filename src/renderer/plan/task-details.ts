import { formatDateTime } from '../../core/civil-format';
import { compareStrings } from '../../core/compare-strings';
import type { Project, Task, TagId, TaskId, TaskSegment } from '../../core/model/project';
import { failure, success, type Result } from '../../core/result';
import { HOURS_PER_DAY, QUARTER_HOUR, type ProjectHour } from '../../core/time';
import { hourFromPicker } from './cell-editing';
import { durationEditorText, parseDuration } from './durations';
import type { EditError } from './task-commands';

export interface BlockDraft {
  readonly duration: string;
  readonly gapDays: string;
  readonly origin: number | null;
  readonly waitsFor: string;
}

export interface TaskDraft {
  readonly name: string;
  readonly tagId: TagId | null;
  readonly progress: string;
  readonly start: string;
  readonly hoursPerDay: string;
  readonly dailyStart: string;
  readonly blocks: readonly BlockDraft[];
  readonly basis: string;
}

export type DetailsError =
  EditError | 'INVALID_BLOCK' | 'INVALID_GAP' | 'INVALID_HOURS_PER_DAY' | 'INVALID_DAILY_START';

const PROGRESS_PATTERN = /^\d{1,3}$/;
const GAP_PATTERN = /^\d{1,4}$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const MAX_PROGRESS = 100;
const MIN_GAP_DAYS = 0;
const ADDED_BLOCK_GAP_DAYS = 1;
const MIN_HOURS_PER_DAY = 1;
const MINUTES_PER_HOUR = 60;
const TWO_DIGITS = 2;
const DECIMAL_RADIX = 10;
const DATE_TIME_SEPARATOR = 'T';
const EMPTY_DRAFT: TaskDraft = {
  name: '',
  tagId: null,
  progress: '0',
  start: '',
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
    start: task.startNoEarlierThan === null ? '' : formatDateTime(task.startNoEarlierThan),
  };
  if (task.kind === 'milestone') {
    return { ...EMPTY_DRAFT, ...common, basis };
  }
  return {
    ...common,
    basis,
    hoursPerDay: task.hoursPerDay === null ? '' : durationEditorText(task.hoursPerDay),
    dailyStart: task.dailyStartHour === null ? '' : timeOfDay(task.dailyStartHour),
    blocks: task.segments.map((segment, block) => ({
      duration: durationEditorText(segment.durationHours),
      gapDays: String(segment.gapDaysBefore),
      origin: block,
      waitsFor: waitsFor(block),
    })),
  };
}

/** Describes a task and the links that touch it, in an order that does not depend on the project, so that two descriptions differ only when the task or its links changed. */
export function taskBasis(project: Project, id: TaskId): string {
  const task = project.tasks.find((candidate) => candidate.id === id);
  const links = project.dependencies
    .filter((link) => link.predecessorId === id || link.successorId === id)
    .sort((left, right) => compareStrings(left.id, right.id));
  return JSON.stringify([task, links]);
}

/** Builds the task the details panel asks for, reading every field, or tells which field cannot be read. */
export function taskFromDraft(
  task: Task,
  draft: TaskDraft,
  dayHours: number,
): Result<Task, DetailsError> {
  const name = draft.name.trim();
  if (name === '') {
    return failure('INVALID_NAME');
  }
  if (task.kind === 'summary') {
    return success({ ...task, name });
  }
  const progress = readProgress(draft.progress);
  const start = readStart(draft.start);
  if (progress === null) {
    return failure('INVALID_PROGRESS');
  }
  if (start === undefined) {
    return failure('INVALID_DATE');
  }
  const dated = {
    ...task,
    name,
    tagId: draft.tagId,
    progressPercent: progress,
    startNoEarlierThan: start,
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
    origin: null,
    waitsFor: '',
  };
  return { ...draft, blocks: [...draft.blocks, block] };
}

/** Returns the blocks of a draft without the block at an index, the first block always keeping no gap. */
export function withoutBlock(draft: TaskDraft, index: number): TaskDraft {
  if (draft.blocks.length <= 1) {
    return draft;
  }
  const blocks = draft.blocks.filter((_block, position) => position !== index);
  return {
    ...draft,
    blocks: blocks.map((block, position) => (position === 0 ? { ...block, gapDays: '0' } : block)),
  };
}

/** Reads a whole progress from 0 to 100, or null. */
function readProgress(text: string): number | null {
  const trimmed = text.trim();
  const value = PROGRESS_PATTERN.test(trimmed)
    ? Number.parseInt(trimmed, DECIMAL_RADIX)
    : Number.NaN;
  return value >= 0 && value <= MAX_PROGRESS ? value : null;
}

/** Reads the optional start of a task from a date and time picker, null meaning none and undefined an unreadable date. */
function readStart(text: string): ProjectHour | null | undefined {
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
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  const match = TIME_PATTERN.exec(trimmed);
  const hours =
    Number(match?.[1] ?? Number.NaN) + Number(match?.[2] ?? Number.NaN) / MINUTES_PER_HOUR;
  const onQuarter = Number.isInteger(hours / QUARTER_HOUR);
  return onQuarter && hours >= 0 && hours < HOURS_PER_DAY ? hours : undefined;
}

/** Reads the blocks of a work task: a duration each, and a gap of whole days before every block after the first. */
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
    segments.push({ durationHours, gapDaysBefore: gap });
  }
  return segments.length === 0 ? failure('INVALID_BLOCK') : success(segments);
}

/** Reads a gap of whole days between two blocks, zero meaning the same day, or null. */
function readGap(text: string): number | null {
  const trimmed = text.trim();
  const value = GAP_PATTERN.test(trimmed) ? Number.parseInt(trimmed, DECIMAL_RADIX) : Number.NaN;
  return value >= MIN_GAP_DAYS ? value : null;
}

/** Writes a time of day as "HH:MM". */
function timeOfDay(hours: number): string {
  const minutes = Math.round(hours * MINUTES_PER_HOUR);
  const hour = String(Math.floor(minutes / MINUTES_PER_HOUR)).padStart(TWO_DIGITS, '0');
  return `${hour}:${String(minutes % MINUTES_PER_HOUR).padStart(TWO_DIGITS, '0')}`;
}
