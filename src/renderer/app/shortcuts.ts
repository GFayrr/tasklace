export type Command = 'newProject' | 'open' | 'save' | 'saveAs' | 'undo' | 'redo';

export interface KeyPress {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

const SHORTCUTS: Readonly<Record<string, readonly [Command, Command]>> = {
  n: ['newProject', 'newProject'],
  o: ['open', 'open'],
  s: ['save', 'saveAs'],
  z: ['undo', 'redo'],
  y: ['redo', 'redo'],
};
const TEXT_HISTORY_COMMANDS: ReadonlySet<Command> = new Set(['undo', 'redo']);

/** Returns the command of a keyboard shortcut, leaving undo and redo to a text field being edited. */
export function commandOf(press: KeyPress, isEditingText: boolean): Command | null {
  if (press.ctrlKey === press.metaKey || press.altKey) {
    return null;
  }
  const commands = SHORTCUTS[press.key.toLowerCase()];
  if (commands === undefined) {
    return null;
  }
  const command = press.shiftKey ? commands[1] : commands[0];
  return isEditingText && TEXT_HISTORY_COMMANDS.has(command) ? null : command;
}
