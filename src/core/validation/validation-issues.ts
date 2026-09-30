import type { CalendarErrorCode } from '../calendar/compile-calendar';
import type { DailyWindowErrorCode } from '../calendar/task-slots';
import { MAX_REPORTED_ISSUES } from '../limits';
import type { StructureErrorCode } from '../scheduling/project-structure';
import type { PlacementErrorCode } from '../scheduling/task-placement';

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
  | 'EMPTY_LIST'
  | 'TOO_MANY_ISSUES'
  | 'DUPLICATE_ENTRY'
  | 'TOO_MANY_REPAIRS'
  | 'READ_ONLY_FIELD';

export type ImportIssueCode =
  | 'INVALID_CSV'
  | 'INVALID_NOTATION'
  | 'INVALID_NUMBER'
  | 'UNSUPPORTED_UNIT'
  | 'UNKNOWN_REFERENCE'
  | 'DURATION_MISMATCH'
  | 'UNSCHEDULABLE';

export type ValidationIssueCode =
  | ValueIssueCode
  | ImportIssueCode
  | CalendarErrorCode
  | DailyWindowErrorCode
  | StructureErrorCode
  | PlacementErrorCode;

export interface ValidationIssue {
  readonly path: string;
  readonly code: ValidationIssueCode;
}

export interface IssueList {
  readonly issues: readonly ValidationIssue[];
  readonly add: (path: string, code: ValidationIssueCode) => void;
}

/** Creates an empty list of issues that ends with a single TOO_MANY_ISSUES entry once the reporting limit is reached. */
export function createIssueList(): IssueList {
  const issues: ValidationIssue[] = [];
  const lastSlot = MAX_REPORTED_ISSUES - 1;
  return {
    issues,
    add: (path, code) => {
      if (issues.length < lastSlot) {
        issues.push({ path, code });
      } else if (issues.length === lastSlot) {
        issues.push({ path: '', code: 'TOO_MANY_ISSUES' });
      }
    },
  };
}
