import { flushSync, mount, unmount, type Component } from 'svelte';
import { afterEach } from 'vitest';

const mounted: (() => void)[] = [];

afterEach(() => {
  for (const remove of mounted.splice(0)) {
    remove();
  }
  document.body.replaceChildren();
});

/** Mounts a component in the page with its properties, and removes it after the test. */
export function render<Props extends Record<string, unknown>>(
  component: Component<Props>,
  props: Props,
): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  const instance = mount(component, { target, props });
  flushSync();
  mounted.push(() => {
    void unmount(instance);
  });
  return target;
}

/** Applies pending updates of the interface at once. */
export function update(): void {
  flushSync();
}

/** Finds the only element matching a selector inside an element, failing the test otherwise. */
export function single(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelectorAll(selector);
  const [element] = found;
  if (found.length !== 1 || !(element instanceof HTMLElement)) {
    throw new Error(`Expected one ${selector}, found ${String(found.length)}`);
  }
  return element;
}

/** Finds the element at a position among those matching a selector, failing the test when there is none. */
export function nth(root: ParentNode, selector: string, index: number): HTMLElement {
  const element = root.querySelectorAll(selector)[index];
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing ${selector} number ${String(index)}`);
  }
  return element;
}

/** Finds the only dialog inside an element, failing the test otherwise. */
export function dialogIn(root: ParentNode): HTMLDialogElement {
  const element = single(root, 'dialog');
  if (!(element instanceof HTMLDialogElement)) {
    throw new Error('Not a dialog');
  }
  return element;
}

/** Finds the button of an element with a visible text or an accessible name, failing the test when there is none or several. */
export function button(root: ParentNode, name: string): HTMLButtonElement {
  const matches = [...root.querySelectorAll<HTMLButtonElement>('button')].filter(
    (candidate) =>
      candidate.textContent.trim() === name || candidate.getAttribute('aria-label') === name,
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one button "${name}", found ${String(matches.length)}`);
  }
  const [found] = matches;
  if (found === undefined) {
    throw new Error(`Missing button ${name}`);
  }
  return found;
}

/** Clicks an element and applies the updates it causes. */
export function click(element: HTMLElement): void {
  element.click();
  flushSync();
}

/** Sends a key press to an element and applies the updates it causes, telling whether the page kept the default action. */
export function press(
  element: EventTarget,
  key: string,
  modifiers: Partial<Pick<KeyboardEventInit, 'altKey' | 'ctrlKey' | 'shiftKey' | 'metaKey'>> = {},
): boolean {
  const kept = element.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }),
  );
  flushSync();
  return kept;
}
