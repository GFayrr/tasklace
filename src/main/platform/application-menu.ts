import { Menu } from 'electron';

const MAC_PLATFORM = 'darwin';

/** Removes the default menu, whose items the toolbar already offers and which would open developer tools, keeping on macOS only the application and editing menus that its text shortcuts need. */
export function installApplicationMenu(platform: NodeJS.Platform): void {
  if (platform !== MAC_PLATFORM) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]));
}
