import { describe, expect, it } from 'vitest';
import MenuButton from './MenuButton.svelte';
import { button, click, nth, press, render, update } from './testing/render';

/** Renders a menu of two items, returning the page part and the recorded choices. */
function renderMenu() {
  const chosen: string[] = [];
  const items = [
    { key: 'one', label: 'Thesis', hint: '/projects', select: () => chosen.push('one') },
    { key: 'two', label: 'Thesis', select: () => chosen.push('two') },
  ];
  const root = render(MenuButton, { label: 'Open', items });
  return { root, chosen };
}

describe('MenuButton', () => {
  it('opens on click, lists items with the same name apart with their folder, and runs the chosen one', () => {
    const { root, chosen } = renderMenu();
    const toggle = button(root, 'Open');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const items = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent.replace(/\s+/g, ' ').trim())).toEqual([
      'Thesis /projects',
      'Thesis',
    ]);
    click(nth(root, '[role="menuitem"]', 1));
    expect(chosen).toEqual(['two']);
    expect(root.querySelector('[role="menu"]')).toBeNull();
  });

  it('closes with Escape or a pointer elsewhere, and stays open for a pointer inside', () => {
    const { root } = renderMenu();
    const toggle = button(root, 'Open');
    click(toggle);
    press(window, 'Enter');
    expect(root.querySelector('[role="menu"]')).not.toBeNull();
    press(window, 'Escape');
    expect(root.querySelector('[role="menu"]')).toBeNull();
    click(toggle);
    toggle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    update();
    expect(root.querySelector('[role="menu"]')).not.toBeNull();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    update();
    expect(root.querySelector('[role="menu"]')).toBeNull();
  });
});
