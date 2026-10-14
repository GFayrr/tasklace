import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain as electronIpcMain, type BrowserWindow, type WebContents } from 'electron';
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

const writing = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock('./safe-write', async (importOriginal) => {
  const original = await importOriginal<typeof import('./safe-write')>();
  return {
    writeFileSafely: (path: string, content: Uint8Array) =>
      writing.failure === null
        ? original.writeFileSafely(path, content)
        : Promise.reject(writing.failure),
  };
});

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

/** A hidden print window that records what it loads and answers printing with a PDF the test chooses, its process ending when the test says. */
class FakePrintWindow {
  readonly loaded: string[] = [];
  readonly served: (string | null)[] = [];
  destroyed = false;
  readonly webContents = {
    printToPDF: vi.fn<(options: unknown) => Promise<Buffer>>(() => printing.answer()),
    once: (event: string, listener: (event: unknown, details: { reason: string }) => void) => {
      if (event === 'render-process-gone') {
        this.end = (reason) => {
          listener({}, { reason });
        };
      }
    },
  };

  /** Ends the process of the window, as a crash does. */
  end: (reason: string) => void = () => undefined;

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
const heldUrls: string[] = [];
const windowCreation = { failure: null as Error | null };
const windows: FakePrintWindow[] = [];
const trusted = vi.fn();
const printing = {
  load: (): Promise<void> => Promise.resolve(),
  answer: (): Promise<Buffer> => Promise.resolve(fakePdf(1)),
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

const handlers = registerPdfHandlers({
  assertTrusted: trusted,
  pages: {
    hold: (html) => {
      const held = pages.hold(html);
      heldUrls.push(held.url);
      return held;
    },
    pageAt: pages.pageAt,
  },
  createPrintWindow: () => {
    if (windowCreation.failure !== null) {
      throw windowCreation.failure;
    }
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
  heldUrls.length = 0;
  windowCreation.failure = null;
  writing.failure = null;
  trusted.mockReset();
  dialogs.save.mockReset();
  services.timeoutMs = 1_000;
  printing.load = () => Promise.resolve();
  printing.answer = () => Promise.resolve(fakePdf(1));
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

/** Builds what Chromium prints: a PDF declaring its pages and the printed font, padded to a number of bytes when one is given. */
function fakePdf(pageCount: number, bytes = 0): Buffer {
  const content = `%PDF-1.4 /BaseFont /ABCDEF+Jost-Book /Type /Pages ${'/Type /Page '.repeat(pageCount)}`;
  return Buffer.from(content.padEnd(bytes, ' '), 'latin1');
}

/** Makes printing answer a complete PDF of a given number of bytes and pages. */
function printsBytes(count: number, pageCount = 1): Buffer {
  const pdf = fakePdf(pageCount, count);
  printing.answer = () => Promise.resolve(pdf);
  return pdf;
}

/** Returns a window of the application as the sender of its requests, open until the test closes it. */
function page(): { isDestroyed: () => boolean; closed: boolean } {
  const sender = {
    closed: false,
    isDestroyed: () => sender.closed,
  };
  return sender;
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
    expect(await request(IPC_CHANNELS.exportPdf, page(), DOCUMENT, 'Thesis')).toEqual(
      success({ kind: 'exported', fileName: 'thesis.pdf' }),
    );
    expect(await readFile(join(folder, 'thesis.pdf'))).toEqual(fakePdf(1));
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
      printsBytes(bytes, pageCount);
      chooseToSave(join(folder, 'plan.pdf'));
      expect(await request(IPC_CHANNELS.exportPdf, page(), documentOf(pageCount), 'Plan')).toEqual(
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
      printsBytes(bytes, pageCount);
      expect(await request(IPC_CHANNELS.exportPdf, page(), documentOf(pageCount), 'Plan')).toEqual(
        success({ kind: 'heavy', bytes, pages: pageCount }),
      );
      expect(dialogs.save).not.toHaveBeenCalled();
    },
  );

  it('writes the PDF kept back when the user exports it as it is, once', async () => {
    const sender = page();
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
    const sender = page();
    printsBytes(PDF_GUARD_BYTES_PER_PAGE * PDF_GUARD_MIN_PAGES + 1);
    await request(IPC_CHANNELS.exportPdf, sender, DOCUMENT, 'Thesis');
    expect((await quietly(() => request(IPC_CHANNELS.saveHeldPdf, page()))).answer).toEqual(
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
      await request(IPC_CHANNELS.exportPdf, page(), documentOf(PDF_GUARD_MIN_PAGES * 4), 'Plan'),
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
    expect(await quietly(() => request(IPC_CHANNELS.exportPdf, page(), broken, 'Plan'))).toEqual({
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
    await expect(request(IPC_CHANNELS.exportPdf, page(), DOCUMENT, 7)).rejects.toThrow(
      RefusedRequest,
    );
    expect(windows).toEqual([]);
  });

  it('reports an export that could not be written as a failed write, logged', async () => {
    chooseToSave(join(folder, 'missing', 'plan.pdf'));
    const written = await quietly(() => request(IPC_CHANNELS.exportPdf, page(), DOCUMENT, 'Plan'));
    expect(written.answer).toEqual(failure({ code: 'WRITE_FAILED' }));
    expect(written.logged).toEqual([
      ['The PDF could not be written:', expect.objectContaining({ code: 'ENOENT' })],
    ]);
  });

  it('gives up printing that takes longer than the time allowed as a failed print, logged, the window destroyed and the page released', async () => {
    services.timeoutMs = 5;
    printing.answer = () => new Promise(() => undefined);
    const late = await quietly(() => request(IPC_CHANNELS.exportPdf, page(), DOCUMENT, 'Plan'));
    expect(late.answer).toEqual(failure({ code: 'PRINT_FAILED' }));
    expect(late.logged).toEqual([
      [
        'The PDF could not be printed:',
        expect.objectContaining({
          name: 'PrintingStopped',
          message: 'Printing to PDF took more than 5 ms.',
        }),
      ],
    ]);
    expect(windows[0]?.destroyed).toBe(true);
    expect(pages.pageAt(windows[0]?.loaded[0] ?? '')).toBeNull();
  });

  it('reports a page that could not be loaded for printing as a failed task, the window destroyed', async () => {
    const refused = new Error('ERR_FAILED');
    printing.load = () => Promise.reject(refused);
    expect(await quietly(() => request(IPC_CHANNELS.exportPdf, page(), DOCUMENT, 'Plan'))).toEqual({
      answer: failure({ code: 'TASK_FAILED' }),
      logged: [['The request project:export-pdf failed:', refused]],
    });
    expect(windows[0]?.destroyed).toBe(true);
  });

  it('writes the document kept back as a lighter PDF made in the file worker, once, whatever its size', async () => {
    const sender = page();
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
    const sender = page();
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
    expect(await quietly(() => request(IPC_CHANNELS.exportLighterPdf, page()))).toEqual({
      answer: failure({ code: 'TASK_FAILED' }),
      logged: [['No PDF was kept back for this window.']],
    });
    expect(tasks).toEqual([]);
  });

  it('reports a window of printing whose process ended as a failed print, logged, the window destroyed and the page released', async () => {
    printing.answer = () => {
      windows[0]?.end('oom');
      return new Promise(() => undefined);
    };
    expect(await quietly(() => request(IPC_CHANNELS.exportPdf, page(), DOCUMENT, 'Plan'))).toEqual({
      answer: failure({ code: 'PRINT_FAILED' }),
      logged: [
        [
          'The PDF could not be printed:',
          expect.objectContaining({
            name: 'PrintingStopped',
            message: 'The printing window ended: oom.',
          }),
        ],
      ],
    });
    expect(windows[0]?.destroyed).toBe(true);
    expect(heldUrls.map((url) => pages.pageAt(url))).toEqual([null]);
  });

  it.each([
    ['without the printed font', Buffer.from('%PDF-1.4 /Type /Page ', 'latin1')],
    ['with fewer pages than the document', fakePdf(0)],
    ['with more pages than the document', fakePdf(2)],
  ])(
    'refuses a printed PDF %s, as a page printed without its style sheet or fonts, logged and never written',
    async (_case, pdf) => {
      printing.answer = () => Promise.resolve(pdf);
      expect(
        await quietly(() => request(IPC_CHANNELS.exportPdf, page(), DOCUMENT, 'Plan')),
      ).toEqual({
        answer: failure({ code: 'PRINT_INCOMPLETE' }),
        logged: [
          [
            'The printed PDF lacks pages or the printed font: a file of the interface was not served.',
          ],
        ],
      });
      expect(dialogs.save).not.toHaveBeenCalled();
    },
  );

  it('counts page objects written with any blanks or none, never the tree of pages', async () => {
    printing.answer = () =>
      Promise.resolve(
        Buffer.from(
          '%PDF-1.4 +Jost /Type/Page /Type\n\t /Page /Type /Pages /Type /Pages',
          'latin1',
        ),
      );
    chooseToSave(join(folder, 'plan.pdf'));
    expect(await request(IPC_CHANNELS.exportPdf, page(), documentOf(2), 'Plan')).toEqual(
      success({ kind: 'exported', fileName: 'plan.pdf' }),
    );
  });

  it('releases the page to print when the hidden window cannot be created, the failure passed on', async () => {
    const refused = new Error('No window');
    windowCreation.failure = refused;
    expect(await quietly(() => request(IPC_CHANNELS.exportPdf, page(), DOCUMENT, 'Plan'))).toEqual({
      answer: failure({ code: 'TASK_FAILED' }),
      logged: [['The request project:export-pdf failed:', refused]],
    });
    expect(heldUrls).toHaveLength(1);
    expect(heldUrls.map((url) => pages.pageAt(url))).toEqual([null]);
  });

  it('cancels an export whose window closed while its PDF was being made, asking nothing and keeping nothing', async () => {
    const light = page();
    printing.answer = () => {
      light.closed = true;
      return Promise.resolve(fakePdf(1));
    };
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await request(IPC_CHANNELS.exportPdf, light, DOCUMENT, 'Plan')).toEqual(
      failure({ code: 'CANCELLED' }),
    );
    const heavy = page();
    const pdf = fakePdf(1, PDF_GUARD_BYTES_PER_PAGE * PDF_GUARD_MIN_PAGES + 1);
    printing.answer = () => {
      heavy.closed = true;
      return Promise.resolve(pdf);
    };
    expect(await request(IPC_CHANNELS.exportPdf, heavy, DOCUMENT, 'Plan')).toEqual(
      failure({ code: 'CANCELLED' }),
    );
    heavy.closed = false;
    expect((await quietly(() => request(IPC_CHANNELS.saveHeldPdf, heavy))).answer).toEqual(
      failure({ code: 'TASK_FAILED' }),
    );
    expect(warned.mock.calls).toEqual([
      ['The export closed while its PDF was being made.'],
      ['The export closed while its PDF was being made.'],
    ]);
    expect(dialogs.save).not.toHaveBeenCalled();
    warned.mockRestore();
  });

  it('forgets the PDF kept back when the page closes its export, or when the main process reloads the window', async () => {
    const sender = page();
    printsBytes(PDF_GUARD_BYTES_PER_PAGE * PDF_GUARD_MIN_PAGES + 1);
    await request(IPC_CHANNELS.exportPdf, sender, DOCUMENT, 'Thesis');
    expect(await request(IPC_CHANNELS.discardHeldPdf, sender)).toEqual(success(null));
    expect((await quietly(() => request(IPC_CHANNELS.saveHeldPdf, sender))).answer).toEqual(
      failure({ code: 'TASK_FAILED' }),
    );
    await request(IPC_CHANNELS.exportPdf, sender, DOCUMENT, 'Thesis');
    handlers.forgetHeldPdf(sender as unknown as WebContents);
    expect((await quietly(() => request(IPC_CHANNELS.exportLighterPdf, sender))).answer).toEqual(
      failure({ code: 'TASK_FAILED' }),
    );
  });

  it('keeps nothing back for an export the page closed while Chromium was still printing it', async () => {
    const sender = page();
    let answer: (pdf: Buffer) => void = () => undefined;
    printing.answer = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const exporting = request(IPC_CHANNELS.exportPdf, sender, DOCUMENT, 'Thesis');
    await vi.waitFor(() => {
      expect(windows).toHaveLength(1);
    });
    await request(IPC_CHANNELS.discardHeldPdf, sender);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    answer(fakePdf(1, PDF_GUARD_BYTES_PER_PAGE * PDF_GUARD_MIN_PAGES + 1));
    expect(await exporting).toEqual(failure({ code: 'CANCELLED' }));
    expect(warned.mock.calls).toEqual([['The export closed while its PDF was being made.']]);
    warned.mockRestore();
    expect((await quietly(() => request(IPC_CHANNELS.saveHeldPdf, sender))).answer).toEqual(
      failure({ code: 'TASK_FAILED' }),
    );
  });

  it('passes on an error of the write that is no failure of the system as a failed task, logged', async () => {
    const broken = new Error('Not a system error');
    writing.failure = broken;
    chooseToSave(join(folder, 'plan.pdf'));
    expect(await quietly(() => request(IPC_CHANNELS.exportPdf, page(), DOCUMENT, 'Plan'))).toEqual({
      answer: failure({ code: 'TASK_FAILED' }),
      logged: [['The request project:export-pdf failed:', broken]],
    });
  });

  it('keeps the PDF back when the file worker fails or the lighter PDF cannot be written', async () => {
    const sender = page();
    printsBytes(PDF_GUARD_BYTES_PER_PAGE * PDF_GUARD_MIN_PAGES + 1);
    await request(IPC_CHANNELS.exportPdf, sender, DOCUMENT, 'Thesis');
    const lost = new Error('Worker lost');
    lighter.answer = () => Promise.reject(lost);
    expect(await quietly(() => request(IPC_CHANNELS.exportLighterPdf, sender))).toEqual({
      answer: failure({ code: 'TASK_FAILED' }),
      logged: [['The request project:export-lighter-pdf failed:', lost]],
    });
    lighter.answer = () => Promise.resolve(success({ kind: 'directPdf', pdf: LIGHTER_PDF }));
    chooseToSave(join(folder, 'missing', 'lighter.pdf'));
    const unwritten = await quietly(() => request(IPC_CHANNELS.exportLighterPdf, sender));
    expect(unwritten.answer).toEqual(failure({ code: 'WRITE_FAILED' }));
    expect(unwritten.logged).toEqual([
      ['The PDF could not be written:', expect.objectContaining({ code: 'ENOENT' })],
    ]);
    chooseToSave(join(folder, 'heavy.pdf'));
    expect(await request(IPC_CHANNELS.saveHeldPdf, sender)).toEqual(
      success({ fileName: 'heavy.pdf' }),
    );
  });

  it('gives the files of the printed weights of Jost in a fonts folder', () => {
    const folder = join('app', 'fonts');
    expect(printFontsIn(folder)).toEqual({
      400: join(folder, 'jost-print-400.ttf'),
      500: join(folder, 'jost-print-500.ttf'),
      600: join(folder, 'jost-print-600.ttf'),
    });
  });

  it('answers nothing to a page that is not the application', async () => {
    trusted.mockImplementation(() => {
      throw new RefusedRequest('not the application');
    });
    await expect(request(IPC_CHANNELS.exportPdf, page(), DOCUMENT, 'Plan')).rejects.toThrow(
      RefusedRequest,
    );
    await expect(request(IPC_CHANNELS.saveHeldPdf, page())).rejects.toThrow(RefusedRequest);
    await expect(request(IPC_CHANNELS.exportLighterPdf, page())).rejects.toThrow(RefusedRequest);
    await expect(request(IPC_CHANNELS.discardHeldPdf, page())).rejects.toThrow(RefusedRequest);
    expect(windows).toEqual([]);
  });
});
