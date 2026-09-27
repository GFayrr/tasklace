import type { CalendarErrorCode } from '../calendar/compile-calendar';
import type { DailyWindowErrorCode } from '../calendar/task-slots';
import { MAX_REPORTED_ISSUES } from '../limits';
import type { StructureErrorCode } from '../scheduling/project-structure';

export type ValueIssueCode =
  | 'INVALID_JSON'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'UNSUPPORTED_VERSION'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'WRONG_TYPE'
  | 'OUT_OF_RANGE'
  | 'TOO_LONG'
  | 'EMPTY_TEXT'
  | 'INVALID_TEXT'
  | 'INVALID_IDENTIFIER'
  | 'INVALID_DATE'
  | 'INVALID_COLOR'
  | 'TOO_MANY_ITEMS'
  | 'EMPTY_LIST';

export type ValidationIssueCode =
  ValueIssueCode | CalendarErrorCode | DailyWindowErrorCode | StructureErrorCode;

export interface ValidationIssue {
  readonly path: string;
  readonly code: ValidationIssueCode;
}

export interface IssueList {
  readonly issues: readonly ValidationIssue[];
  readonly add: (path: string, code: ValidationIssueCode) => void;
}

/** Creates an empty list of issues that stops recording once the reporting limit is reached. */
export function createIssueList(): IssueList {
  const issues: ValidationIssue[] = [];
  return {
    issues,
    add: (path, code) => {
      if (issues.length < MAX_REPORTED_ISSUES) {
        issues.push({ path, code });
      }
    },
  };
}
