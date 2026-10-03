import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createMainWindow } from './window';

const created = vi.hoisted(() => [] as { options: unknown; shown: boolean }[]);

vi.mock('electron', async () => {
  const events = await import('node:events');
  class BrowserWindow extends events.EventEmitter {
    readonly record: { options: unknown; shown: boolean };

    /** Records the options of a new window. */
    constructor(options: unknown) {
      super();
      this.record = { options, shown: false };
      created.push(this.record);
    }

    /** Records that the window was shown. */
    show(): void {
      this.record.shown = true;
    }
  }
  return { BrowserWindow };
});

describe('createMainWindow', () => {
  it('creates a hidden window with every page protection, shown once its content is ready', () => {
    const window = createMainWindow('/app/preload.cjs') as unknown as EventEmitter;
    const [record] = created;
    expect(record?.options).toEqual({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        preload: '/app/preload.cjs',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        experimentalFeatures: false,
      },
    });
    expect(record?.shown).toBe(false);
    window.emit('ready-to-show');
    expect(record?.shown).toBe(true);
  });
});
