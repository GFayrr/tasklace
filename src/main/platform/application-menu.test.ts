import { afterEach, describe, expect, it, vi } from 'vitest';
import { installApplicationMenu } from './application-menu';

const setApplicationMenu = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  Menu: {
    setApplicationMenu,
    buildFromTemplate: (template: unknown) => ({ template }),
  },
}));

afterEach(() => {
  setApplicationMenu.mockClear();
});

describe('installApplicationMenu', () => {
  it.each(['win32', 'linux'] as const)('removes the menu on %s', (platform) => {
    installApplicationMenu(platform);
    expect(setApplicationMenu).toHaveBeenCalledWith(null);
  });

  it('keeps only the application and editing menus on macOS', () => {
    installApplicationMenu('darwin');
    expect(setApplicationMenu).toHaveBeenCalledWith({
      template: [{ role: 'appMenu' }, { role: 'editMenu' }],
    });
  });
});
