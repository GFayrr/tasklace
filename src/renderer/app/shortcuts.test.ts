import { describe, expect, it } from 'vitest';
import { commandOf, type KeyPress } from './shortcuts';

/** Builds a key press with the control key held. */
function control(key: string, shiftKey = false): KeyPress {
  return { key, ctrlKey: true, metaKey: false, shiftKey, altKey: false };
}

describe('commandOf', () => {
  it.each([
    [control('n'), 'newProject'],
    [control('o'), 'open'],
    [control('s'), 'save'],
    [control('S', true), 'saveAs'],
    [control('z'), 'undo'],
    [control('Z', true), 'redo'],
    [control('y'), 'redo'],
  ])('maps %j to %s', (press, command) => {
    expect(commandOf(press, false)).toBe(command);
  });

  it('accepts the command key instead of the control key', () => {
    expect(commandOf({ ...control('z'), ctrlKey: false, metaKey: true }, false)).toBe('undo');
  });

  it('ignores plain keys, other keys and extra modifiers', () => {
    expect(commandOf({ ...control('z'), ctrlKey: false }, false)).toBeNull();
    expect(commandOf({ ...control('z'), metaKey: true }, false)).toBeNull();
    expect(commandOf({ ...control('z'), altKey: true }, false)).toBeNull();
    expect(commandOf(control('q'), false)).toBeNull();
  });

  it('leaves undo and redo to a text field being edited, but not saving', () => {
    expect(commandOf(control('z'), true)).toBeNull();
    expect(commandOf(control('y'), true)).toBeNull();
    expect(commandOf(control('s'), true)).toBe('save');
  });
});
