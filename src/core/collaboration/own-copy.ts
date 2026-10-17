import { MAX_PROJECT_NAME_LENGTH } from '../limits';

export const PLAN_PLACEHOLDER = '{plan}';

/** Names the separate plan that keeps the changes a person could not share, filling the template with the name of the shared plan cut short by code points so that the whole name stays within the length of a project name. */
export function ownCopyName(planName: string, template: string): string {
  const room = MAX_PROJECT_NAME_LENGTH - Array.from(template.replace(PLAN_PLACEHOLDER, '')).length;
  const shortened = Array.from(planName).slice(0, Math.max(0, room)).join('').trimEnd();
  return template.replace(PLAN_PLACEHOLDER, shortened);
}
