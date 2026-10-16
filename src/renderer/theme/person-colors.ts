import { valueAt } from '../../core/table-value';

export const PERSON_COLORS: readonly string[] = [
  '#1F5FA8',
  '#8A3A8F',
  '#1D7A5A',
  '#A1532A',
  '#B0305A',
  '#5E6414',
  '#4F5868',
  '#6B3FC0',
];

/** Gives the color of a person from the position the host gave them in the palette of people, throwing for a position outside it. */
export function personColorOf(color: number): string {
  return valueAt(PERSON_COLORS, color);
}
