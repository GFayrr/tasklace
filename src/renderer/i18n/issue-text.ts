import type { CsvWarningCode } from '../../core/exchange/csv/csv-rows';
import type { SharedRepairCode } from '../../core/shared/shared-project';
import type { ValidationIssueCode } from '../../core/validation/validation-issues';
import { fillMessage, type Messages } from './messages';

export type IssueCode = ValidationIssueCode | CsvWarningCode;

export interface ReportedIssue {
  readonly path: string;
  readonly code: string;
}

type CountedEntity = 'row' | 'column' | 'task' | 'link' | 'tag';

const INDEXED_SEGMENT = /^[A-Za-z]+\[\d+\]$/;
const MAX_PATH_LENGTH = 256;
const ENTITIES: Readonly<
  Record<string, { readonly entity: CountedEntity; readonly offset: number }>
> = {
  rows: { entity: 'row', offset: 0 },
  columns: { entity: 'column', offset: 0 },
  tasks: { entity: 'task', offset: 1 },
  dependencies: { entity: 'link', offset: 1 },
  tags: { entity: 'tag', offset: 1 },
};

/** Writes a problem found in a file for the user: where it is, as a row, column, task, link or tag and a field, then what is wrong. */
export function issueText(messages: Messages, issue: ReportedIssue): string {
  const reason = issueReason(messages, issue.code);
  const segments = issue.path.length > MAX_PATH_LENGTH ? [] : issue.path.split('.').filter(Boolean);
  const place = placeOf(messages, segments[0]);
  const fields = (place === null ? segments : segments.slice(1)).map((segment) =>
    fieldName(messages, segment),
  );
  if (place === null && fields.length === 0) {
    return reason;
  }
  if (place === null || fields.length === 0) {
    return fillMessage(messages.issuePlaces.placed, { place: place ?? fields.join(', '), reason });
  }
  return fillMessage(messages.issuePlaces.located, { place, field: fields.join(', '), reason });
}

/** Writes an adjustment made to keep a project valid, naming the task it concerns when it is a task that still exists. */
export function repairText(
  messages: Messages,
  repair: { readonly code: SharedRepairCode; readonly id: string },
  taskName: (id: string) => string | null,
): string {
  const reasons: Readonly<Record<SharedRepairCode, string>> = messages.repairCodes;
  const name = taskName(repair.id);
  if (name === null) {
    return reasons[repair.code];
  }
  const place = fillMessage(messages.issuePlaces.taskNamed, { name });
  return fillMessage(messages.issuePlaces.placed, { place, reason: reasons[repair.code] });
}

/** Returns the text of a problem code, a general one for a code this version does not know. */
function issueReason(messages: Messages, code: string): string {
  const reasons: Readonly<Record<IssueCode, string>> = messages.issues;
  const known: Readonly<Record<string, string>> = reasons;
  return (
    (Object.hasOwn(known, code) ? known[code] : undefined) ?? messages.issuePlaces.unknownReason
  );
}

/** Names the row, column, task, link or tag a path starts with, or returns null when it starts elsewhere. */
function placeOf(messages: Messages, segment = ''): string | null {
  if (!INDEXED_SEGMENT.test(segment)) {
    return null;
  }
  const bracket = segment.indexOf('[');
  const name = segment.slice(0, bracket);
  const entity = Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : undefined;
  if (entity === undefined) {
    return null;
  }
  const number = String(Number.parseInt(segment.slice(bracket + 1), 10) + entity.offset);
  return fillMessage(messages.issuePlaces[entity.entity], { number });
}

/** Names a field of a path in words, keeping the written name of a field this version does not know, and counts the entries of a list from 1. */
function fieldName(messages: Messages, segment: string): string {
  const bracket = segment.indexOf('[');
  const key = bracket < 0 ? segment : segment.slice(0, bracket);
  const names: Readonly<Record<string, string>> = messages.issueFields;
  const name = (Object.hasOwn(names, key) ? names[key] : undefined) ?? key;
  if (!INDEXED_SEGMENT.test(segment)) {
    return name;
  }
  return `${name} ${String(Number.parseInt(segment.slice(bracket + 1), 10) + 1)}`;
}
