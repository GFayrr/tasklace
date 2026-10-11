import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain as electronIpcMain, type BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrintDocument } from '../core/print/print-document';
import { printHtml } from '../core/print/print-html';
import { failure, success } from '../core/result';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import { createPrintPageStore } from './app-files';
import type { FileTask, FileTaskResult, ResultOfTask } from './file-tasks';
import { RefusedRequest } from './ipc-trust';
import {
  PDF_GUARD_BYTES_PER_PAGE,
  PDF_GUARD_MIN_PAGES,
  printFontsIn,
  registerPdfHandlers,
} from './pdf-export';
import type { FakeIpcMain } from './testing/fake-electron';

const MOCKED_MAX_PDF_BYTES = 2_000_000;

const dialogs = vi.hoisted(() => ({
  save: vi.fn<() => Promise<{ canceled: boolean; filePath: string }>>(),
}));

vi.mock('../core/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/limits')>()),
  MAX_PDF_BYTES: 2_000_000,
}));

vi.mock('electron', async () => {
  const fakes = await import('./testing/fake-electron');
  return {
    app: { getSystemLocale: () => 'en-US' },
    BrowserWindow: { fromWebContents: () => null },
    dialog: {
      showSaveDialog: (...values: unknown[]) => dialogs.save(...(values as [])),
      showOpenDialog: () => Promise.reject(new Error('No open dialog in these tests.')),
      showMessageBox: () => Promise.reject(new Error('No message box in these tests.')),
    },
    ipcMain: new fakes.FakeIpcMain(),
  };
});

/** A hidden print window that records what it loads and answers printing with a PDF the test chooses. */
class FakePrintWindow {
  readonly loaded: string[] = [];
  readonly served: (string | null)[] = [];
  destroyed = false;
  readonly webContents = {
    printToPDF: vi.fn<(options: unknown) => Promise<Buffer>>(() => printing.answer()),
  };

  /** Records the address loaded and the page the store serves there at that moment. */
  loadURL(url: string): Promise<void> {
    this.loaded.push(url);
    this.served.push(pages.pageAt(url));
    return printing.load();
  }

  /** Records that the window was destroyed. */
  destroy(): void {
    this.destroyed = true;
  }
}

const ipcMain = electronIpcMain as unknown as FakeIpcMain;
const pages = createPrintPageStore();
const windows: FakePrintWindow[] = [];
const trusted = vi.fn();
const printing = {
  load: (): Promise<void> => Promise.resolve(),
  answer: (): Promise<Buffer> => Promise.resolve(Buffer.from('%PDF-1.4 light')),
};
const services = { timeoutMs: 1_000 };
const FONTS = { 400: '/fonts/400.ttf', 500: '/fonts/500.ttf', 600: '/fonts/600.ttf' } as const;
const LIGHTER_PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46]);
const tasks: FileTask[] = [];
const lighter = {
  answer: (): Promise<FileTaskResult> =>
    Promise.resolve(success({ kind: 'directPdf', pdf: LIGHTER_PDF })),
};
const DOCUMENT: PrintDocument = {
  paper: 'a4',
  orientation: 'landscape',
  title: 'Thesis',
  pages: [
    [
      {
        kind: 'fill',
        shape: { kind: 'rect', x: 0, y: 0, width: 10, height: 10 },
        color: '#000000',
        opacity: 1,
      },
    ],
  ],
};
let folder: string;

registerPdfHandlers({
  assertTrusted: trusted,
  pages,
  createPrintWindow: () => {
    const window = new FakePrintWindow();
    windows.push(window);
    return window as unknown as BrowserWindow;
  },
  get timeoutMs() {
    return services.timeoutMs;
  },
  runTask: async <T extends FileTask>(task: T) => {
    tasks.push(task);
    return (await lighter.answer()) as ResultOfTask<T>;
  },
  fonts: FONTS,
});

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-pdf-'));
  windows.length = 0;
  trusted.mockReset();
  dialogs.save.mockReset();
  services.timeoutMs = 1_000;
  printing.load = () => Promise.resolve();
  printing.answer = () => Promise.resolve(Buffer.from('%PDF-1.4 light'));
  tasks.length = 0;
  lighter.answer = () => Promise.resolve(success({ kind: 'directPdf', pdf: LIGHTER_PDF }));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** Invokes a request of the bridge from a page, a refusal becoming a rejected promise as through Electron. */
function request(channel: string, sender: object, ...values: unknown[]): Promise<unknown> {
  return new Promise((resolve) => {
    resolve(ipcMain.invoke(channel, { sender }, ...values));
  });
}

/** Makes the next save dialog choose a path, or cancel when none is given. */
function chooseToSave(path: string | null): void {
  dialogs.save.mockResolvedValueOnce(
    path === null ? { canceled: true, filePath: '' } : { canceled: false, filePath: path },
  );
}

/** Makes printing answer a PDF of a given number of bytes. */
function printsBytes(count: number): Buffer {
  const pdf = Buffer.alloc(count, 0x25);
  printing.answer = () => Promise.resolve(pdf);
  return pdf;
}

/** Builds a document of a given number of empty pages. */
function documentOf(pageCount: number): PrintDocument {
  return { ...DOCUMENT, pages: Array.from({ length: pageCount }, () => []) };
}

/** Runs a request while silencing, and returning, what it logs as errors. */
async function quietly(run: () => Promise<unknown>) {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    return { answer: await run(), logged: logged.mock.calls };
  } finally {
    logged.mockRestore();
  }
}

describe('exporting to PDF', () => {
  it('prints the page of the document in a hidden window and writes a light PDF where the user chooses, adding the extension', async () => {
    chooseToSave(join(folder, 'thesis'));
    expect(await request(IPC_CHANNELS.exportPdf, {}, DOCUMENT, 'Thesis')).toEqual(
      success({ kind: 'exported', fileName: 'thesis.pdf' }),
    );
    expect(await readFile(join(folder, 'thesis.pdf'), 'latin1')).toBe('%PDF-1.4 light');
    const [window] = windows;
    expect(window?.served).toEqual([printHtml(DOCUMENT)]);
    expect(window?.loaded[0]).toMatch(/^app:\/\/tasklace\/print\/[0-9a-f-]{36}\.html$/);
    expect(pages.pageAt(window?.loaded[0] ?? '')).toBeNull();
    expect(window?.destroyed).toBe(true);
    expect(window?.webContents.printToPDF.mock.calls).toEqual([
      [
        {
          pageSize: { width: 841.89 / 72, height: 595.28 / 72 },
          landscape: false,
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          printBackground: true,
          preferCSSPageSize: false,
        },
      ],
    ]);
    expect(dialogs.save.mock.calls[0]).toEqual([
      {
        filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
        defaultPath: 'Thesis.pdf',
        properties: ['showOverwriteConfirmation'],
      },
    ]);
  });

  it.each([
    [1, PDF_GUARD_BYTES_PER_PAGE * PDF_GUARD_MIN_PAGES],
    [PDF_GUARD_MIN_PAGES * 2, PDF_GUARD_BYTES_PER_PAGE * PDF_GUARD_MIN_PAGES * 2],
  ])(
    'writes a PDF of %i pages that weighs at most its allowance of %i bytes',
    async (pageCount, bytes) => {
      printsBytes(bytes);
      chooseToSave(join(folder, 'plan.pdf'));
      expect(await request(IPC_CHANNELS.exportPdf, {}, documentOf(pageCount), 'Plan')).toEqual(
        success({ kind: 'exported', fileName: 'plan.pdf' }),
      );
    },
  );

  it.each([
    [1, PDF_GUARD_BYTES_PER_PAGE * PDF_GUARD_MIN_PAGES + 1],
    [PDF_GUARD_MIN_PAGES * 2, PDF_GUARD_BYTES_PER_PAGE * PDF_GUARD_MIN_PAGES * 2 + 1],
  ])(
    'keeps back a PDF of %i pages heavier than its allowance, %i bytes, without asking where to write it',
    async (pageCount, bytes) => {
      printsBytes(bytes);
      expect(await request(IPC_CHANNELS.exportPdf, {}, documentOf(pageCount), 'Plan')).toEqual(
        success({ kind: 'heavy', bytes, pages: pageCount }),
      );
      expect(dialogs.save).not.toHaveBeenCalled();
    },
  );

  it('writes the PDF kept back when the user exports it as it is, once', async () => {
    const sender = {};
    const pdf = printsBytes(PDF_GUARD_BYTES_PER_PAGE * PDF_GUARD_MIN_PAGES + 1);
    await request(IPC_CHANNELS.exportPdf, sender, DOCUMENT, 'Thesis');
    chooseToSave(null);
    expect(await request(IPC_CHANNELS.saveHeldPdf, sender)).toEqual(failure({ code: 'CANCELLED' }));
    chooseToSave(join(folder, 'heavy.pdf'));
    expect(await request(IPC_CHANNELS.saveHeldPdf, sender)).toEqual(
      success({ fileName: 'heavy.pdf' }),
    );
    expect((await readFile(join(folder, 'heavy.pdf'))).equals(pdf)).toBe(true);
    expect(await quietly(() => request(IPC_CHANNELS.saveHeldPdf, sender))).toEqual({
      answer: failure({ code: 'TASK_FAILED' }),
      logged: [['No PDF was kept back for this window.']],
    });
  });

  it('keeps a PDF back for its own window only, and forgets it when the window starts another export', async () => {
    const sender = {};
    printsBytes(PDF_GUARD_BYTES_PER_PAGE * PDF_GUARD_MIN_PAGES + 1);
    await request(IPC_CHANNELS.exportPdf, sender, DOCUMENT, 'Thesis');
    expect((await quietly(() => request(IPC_CHANNELS.saveHeldPdf, {}))).answer).toEqual(
      failure({ code: 'TASK_FAILED' }),
    );
    printsBytes(10);
    chooseToSave(null);
    expect(await request(IPC_CHANNELS.exportPdf, sender, DOCUMENT, 'Thesis')).toEqual(
      failure({ code: 'CANCELLED' }),
    );
    expect((await quietly(() => request(IPC_CHANNELS.saveHeldPdf, sender))).answer).toEqual(
      failure({ code: 'TASK_FAILED' }),
    );
  });

  it('refuses a PDF larger than the limit before keeping or writing it', async () => {
    printsBytes(MOCKED_MAX_PDF_BYTES + 1);
    expect(
      await request(IPC_CHANNELS.exportPdf, {}, documentOf(PDF_GUARD_MIN_PAGES * 4), 'Plan'),
    ).toEqual(failure({ code: 'TOO_LARGE' }));
    expect(dialogs.save).not.toHaveBeenCalled();
  });

  it('refuses a document that breaks the print format, logging why, without printing it', async () => {
    const broken = {
      ...DOCUMENT,
      pages: [
        [
          {
            kind: 'text',
            x: 0,
            y: 0,
            text: 'Tiny',
            size: 6,
            weight: 400,
            color: '#000000',
            align: 'start',
          },
        ],
      ],
    };
    expect(await quietly(() => request(IPC_CHANNELS.exportPdf, {}, broken, 'Plan'))).toEqual({
      answer: failure({ code: 'TASK_FAILED' }),
      logged: [
        [
          'The document to print was refused:',
          [{ path: 'pages[0][0].size', code: 'OUT_OF_RANGE' }],
        ],
      ],
    });
    expect(windows).toEqual([]);
  });

  it('refuses a suggested name that is not a short text', async () => {
    await expect(request(IPC_CHANNELS.exportPdf, {}, DOCUMENT, 7)).rejects.toThrow(RefusedRequest);
    expect(windows).toEqual([]);
  });

  it('reports an export that could not be written as a failed write, logged', async () => {
    chooseToSave(join(folder, 'missing', 'plan.pdf'));
    const written = await quietly(() => request(IPC_CHANNELS.exportPdf, {}, DOCUMENT, 'Plan'));
    expect(written.answer).toEqual(failure({ code: 'WRITE_FAILED' }));
    expect(written.logged.map((call): unknown => call[0])).toEqual([
      'The PDF could not be written:',
    ]);
  });

  it('gives up printing that takes longer than the time allowed, the window destroyed and the page released', async () => {
    services.timeoutMs = 5;
    printing.answer = () => new Promise(() => undefined);
    const late = await quietly(() => request(IPC_CHANNELS.exportPdf, {}, DOCUMENT, 'Plan'));
    expect(late.answer).toEqual(failure({ code: 'TASK_FAILED' }));
    expect(late.logged).toEqual([
      ['The request project:export-pdf failed:', new Error('Printing to PDF took more than 5 ms.')],
    ]);
    expect(windows[0]?.destroyed).toBe(true);
    expect(pages.pageAt(windows[0]?.loaded[0] ?? '')).toBeNull();
  });

  it('reports a page that could not be loaded for printing as a failed task, the window destroyed', async () => {
    const refused = new Error('ERR_FAILED');
    printing.load = () => Promise.reject(refused);
    expect(await quietly(() => request(IPC_CHANNELS.exportPdf, {}, DOCUMENT, 'Plan'))).toEqual({
      answer: failure({ code: 'TASK_FAILED' }),
      logged: [['The request project:export-pdf failed:', refused]],
    });
    expect(windows[0]?.destroyed).toBe(true);
  });

  it('writes the document kept back as a lighter PDF made in the file worker, once, whatever its size', async () => {
    const sender = {};
    printsBytes(PDF_GUARD_BYTES_PER_PAGE * PDF_GUARD_MIN_PAGES + 1);
    await request(IPC_CHANNELS.exportPdf, sender, DOCUMENT, 'Thesis');
    chooseToSave(null);
    expect(await request(IPC_CHANNELS.exportLighterPdf, sender)).toEqual(
      failure({ code: 'CANCELLED' }),
    );
    chooseToSave(join(folder, 'lighter'));
    expect(await request(IPC_CHANNELS.exportLighterPdf, sender)).toEqual(
      success({ fileName: 'lighter.pdf' }),
    );
    expect(await readFile(join(folder, 'lighter.pdf'))).toEqual(Buffer.from(LIGHTER_PDF));
    expect(tasks).toEqual([
      { kind: 'writeDirectPdf', document: DOCUMENT, fonts: FONTS },
      { kind: 'writeDirectPdf', document: DOCUMENT, fonts: FONTS },
    ]);
    expect((await quietly(() => request(IPC_CHANNELS.exportLighterPdf, sender))).answer).toEqual(
      failure({ code: 'TASK_FAILED' }),
    );
    expect((await quietly(() => request(IPC_CHANNELS.saveHeldPdf, sender))).answer).toEqual(
      failure({ code: 'TASK_FAILED' }),
    );
  });

  it('passes on a failure of the file worker, keeping the PDF back for another choice', async () => {
    const sender = {};
    printsBytes(PDF_GUARD_BYTES_PER_PAGE * PDF_GUARD_MIN_PAGES + 1);
    await request(IPC_CHANNELS.exportPdf, sender, DOCUMENT, 'Thesis');
    lighter.answer = () => Promise.resolve(failure({ code: 'TOO_LARGE' }));
    expect(await request(IPC_CHANNELS.exportLighterPdf, sender)).toEqual(
      failure({ code: 'TOO_LARGE' }),
    );
    expect(dialogs.save).not.toHaveBeenCalled();
    chooseToSave(join(folder, 'heavy.pdf'));
    expect(await request(IPC_CHANNELS.saveHeldPdf, sender)).toEqual(
      success({ fileName: 'heavy.pdf' }),
    );
  });

  it('makes no lighter PDF when nothing was kept back, logging why', async () => {
    expect(await quietly(() => request(IPC_CHANNELS.exportLighterPdf, {}))).toEqual({
      answer: failure({ code: 'TASK_FAILED' }),
      logged: [['No PDF was kept back for this window.']],
    });
    expect(tasks).toEqual([]);
  });

  it('gives the files of the printed weights of Jost in a fonts folder', () => {
    expect(printFontsIn('/app/fonts')).toEqual({
      400: '/app/fonts/jost-print-400.ttf',
      500: '/app/fonts/jost-print-500.ttf',
      600: '/app/fonts/jost-print-600.ttf',
    });
  });

  it('answers nothing to a page that is not the application', async () => {
    trusted.mockImplementation(() => {
      throw new RefusedRequest('not the application');
    });
    await expect(request(IPC_CHANNELS.exportPdf, {}, DOCUMENT, 'Plan')).rejects.toThrow(
      RefusedRequest,
    );
    await expect(request(IPC_CHANNELS.saveHeldPdf, {})).rejects.toThrow(RefusedRequest);
    await expect(request(IPC_CHANNELS.exportLighterPdf, {})).rejects.toThrow(RefusedRequest);
    expect(windows).toEqual([]);
  });
});
