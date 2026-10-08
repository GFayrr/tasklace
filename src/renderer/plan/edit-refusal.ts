import type { ValidationIssueCode } from '../../core/validation/validation-issues';

export type ScheduleRefusal = 'SCHEDULE_PENDING' | 'SCHEDULE_STOPPED';

export type TaskEditError =
  | 'NOT_POSSIBLE'
  | 'INVALID_NAME'
  | 'INVALID_DURATION'
  | 'INVALID_DATE'
  | 'INVALID_END'
  | 'OUT_OF_RANGE'
  | 'INVALID_PROGRESS'
  | 'INVALID_PREDECESSORS'
  | 'UNKNOWN_TASK_NUMBER'
  | 'UNKNOWN_BLOCK'
  | 'LINKS_WOULD_MERGE'
  | 'WAITS_NEED_TWO_BLOCKS'
  | 'TASK_CHANGED';

export type SettingsEditError = 'INVALID_TIME' | 'NO_ROOM_FOR_RANGE';

export type TagEditError = 'EMPTY_TAG_NAME' | 'DUPLICATE_TAG_NAME' | 'TOO_MANY_TAGS';

export type BaselineEditError = 'SCHEDULE_FAILED' | 'CLOCK_OUT_OF_RANGE';

export type EditError =
  TaskEditError | ScheduleRefusal | SettingsEditError | TagEditError | BaselineEditError;

export type DetailsEditError =
  | 'INVALID_BLOCK'
  | 'INVALID_GAP'
  | 'INVALID_HOURS_PER_DAY'
  | 'INVALID_DAILY_START'
  | 'INVALID_MUST_FINISH_ON'
  | 'INVALID_DEADLINE';

export type InterfaceRefusal = EditError | DetailsEditError;

export type EditRefusal = InterfaceRefusal | ValidationIssueCode;
