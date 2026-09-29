const FORMULA_TRIGGERS: readonly string[] = ['=', '+', '-', '@', '\t', '\r'];
const TEXT_MARKER = "'";

/** Prefixes with an apostrophe a cell a spreadsheet could run as a formula, and a cell starting with an apostrophe followed by such a character or another apostrophe, so that the import can undo it exactly. */
export function neutralizeFormula(cell: string): string {
  return startsWithFormulaTrigger(cell) || isEscapedCell(cell) ? TEXT_MARKER + cell : cell;
}

/** Removes the apostrophe the export put in front of a cell, and only that one. */
export function restoreFormula(cell: string): string {
  return isEscapedCell(cell) ? cell.slice(TEXT_MARKER.length) : cell;
}

/** Tells whether a cell starts with a character that makes a spreadsheet read it as a formula. */
function startsWithFormulaTrigger(cell: string): boolean {
  return FORMULA_TRIGGERS.includes(cell.charAt(0));
}

/** Tells whether a cell starts with the apostrophe the export adds, followed by a formula trigger or another apostrophe. */
function isEscapedCell(cell: string): boolean {
  const next = cell.charAt(TEXT_MARKER.length);
  return cell.startsWith(TEXT_MARKER) && (FORMULA_TRIGGERS.includes(next) || next === TEXT_MARKER);
}
