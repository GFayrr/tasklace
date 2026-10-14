import { basename, join } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { MAX_PDF_BYTES } from '../core/limits';
import { pageSizeOf } from '../core/print/paper';
import type { PrintDocument } from '../core/print/print-document';
import { printHtml } from '../core/print/print-html';
import { readPrintDocument } from '../core/print/read-print-document';
import { failure, success, type Result } from '../core/result';
import {
  IPC_CHANNELS,
  type BridgeResult,
  type ChannelAnswers,
  type ExportedFile,
  type FileFailure,
  type PdfExport,
  type ResultChannel,
} from '../preload/bridge-contract';
import type { PrintPageStore } from './app-files';
import type { FileTask, ResultOfTask } from './file-tasks';
import type { PrintFonts } from './pdf/direct-pdf';
import { registerChannel } from './ipc-channels';
import { refuseMessage, type TrustCheck } from './ipc-trust';
import { readSuggestedName } from './ipc-validators';
import { answerOrFail, chooseFileToSave } from './project-files';
import { writeFileSafely } from './safe-write';
import { isSystemError } from './stored-files';

export interface PdfServices {
  readonly assertTrusted: TrustCheck;
  readonly pages: PrintPageStore;
  readonly createPrintWindow: () => BrowserWindow;
  readonly timeoutMs: number;
  readonly runTask: <T extends FileTask>(task: T) => Promise<ResultOfTask<T>>;
  readonly fonts: PrintFonts;
}

export interface PdfHandlers {
  readonly forgetHeldPdf: (sender: WebContents) => void;
}

interface HeldPdf {
  readonly pdf: Uint8Array;
  readonly name: string;
  readonly document: PrintDocument;
}

interface HeldPdfStore {
  readonly start: (sender: WebContents) => number;
  readonly hold: (sender: WebContents, ticket: number, kept: HeldPdf) => boolean;
  readonly get: (sender: WebContents) => HeldPdf | undefined;
  readonly forget: (sender: WebContents) => void;
}

/** A failure of the hidden window while it prints, which ended or took longer than allowed. */
class PrintingStopped extends Error {
  /** Tells why printing stopped. */
  constructor(reason: string) {
    super(reason);
    this.name = 'PrintingStopped';
  }
}

export const PDF_GUARD_BYTES_PER_PAGE = 50_000;
export const PDF_GUARD_MIN_PAGES = 10;

const POINTS_PER_INCH = 72;
const PRINTED_FONT_MARK = '+Jost';
const TYPE_KEY = '/Type';
const PAGE_TYPE = '/Page';
const PLURAL_ENDING = 's'.charCodeAt(0);
const PDF_WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/** Answers the bridge requests that print a plan to PDF and that write, as it is or made lighter, or forget a PDF kept back for being heavy, returning how to forget the PDF of a reloaded window. */
export function registerPdfHandlers(services: PdfServices): PdfHandlers {
  const held = createHeldPdfStore();
  /** Registers the answer of a channel, an unexpected failure becoming a task failure. */
  const handle = <C extends ResultChannel>(
    channel: C,
    answer: (event: IpcMainInvokeEvent, ...values: unknown[]) => Promise<ChannelAnswers[C]>,
  ): void => {
    registerChannel(services.assertTrusted, channel, (event, ...values) =>
      answerOrFail(channel, () => answer(event, ...values)),
    );
  };
  handle(IPC_CHANNELS.exportPdf, (event, document, name) =>
    exportPdf(services, held, event.sender, document, name),
  );
  handle(IPC_CHANNELS.saveHeldPdf, (event) => saveHeldPdf(held, event.sender));
  handle(IPC_CHANNELS.exportLighterPdf, (event) => exportLighterPdf(services, held, event.sender));
  handle(IPC_CHANNELS.discardHeldPdf, (event) => {
    held.forget(event.sender);
    return Promise.resolve(success(null));
  });
  return { forgetHeldPdf: held.forget };
}

/** Creates the store of the PDF each window keeps back, numbering the exports of a window so that a PDF printed after the window forgot its export is never kept. */
function createHeldPdfStore(): HeldPdfStore {
  const kept = new WeakMap<WebContents, HeldPdf>();
  const tickets = new WeakMap<WebContents, number>();
  /** Forgets the PDF of a window and the exports it started. */
  const forget = (sender: WebContents): void => {
    kept.delete(sender);
    tickets.set(sender, (tickets.get(sender) ?? 0) + 1);
  };
  return {
    start: (sender) => {
      forget(sender);
      return tickets.get(sender) ?? 0;
    },
    hold: (sender, ticket, pdf) => {
      if (tickets.get(sender) !== ticket) {
        return false;
      }
      kept.set(sender, pdf);
      return true;
    },
    get: (sender) => kept.get(sender),
    forget,
  };
}

/** Prints a document sent by a page to PDF once it is checked, keeping the PDF back when it weighs more than 50 kB per page, at least 10 pages being counted, so that the page can offer a choice, and otherwise asking where to write it. */
async function exportPdf(
  services: PdfServices,
  held: HeldPdfStore,
  sender: WebContents,
  documentValue: unknown,
  nameValue: unknown,
): Promise<BridgeResult<PdfExport>> {
  const ticket = held.start(sender);
  const name = readSuggestedName(nameValue) ?? refuseMessage();
  const read = readPrintDocument(documentValue);
  if (!read.ok) {
    console.error('The document to print was refused:', read.error);
    return failure({ code: 'TASK_FAILED' });
  }
  const printed = await printChecked(services, read.value);
  if (!printed.ok) {
    return printed;
  }
  const pdf = printed.value;
  const pages = read.value.pages.length;
  if (pdf.length > PDF_GUARD_BYTES_PER_PAGE * Math.max(pages, PDF_GUARD_MIN_PAGES)) {
    return !sender.isDestroyed() && held.hold(sender, ticket, { pdf, name, document: read.value })
      ? success({ kind: 'heavy', bytes: pdf.length, pages })
      : closedWhilePrinting();
  }
  const written = await writePdf(sender, pdf, name);
  return written.ok ? success({ kind: 'exported', fileName: written.value.fileName }) : written;
}

/** Prints a checked document and checks the PDF, refusing one larger than allowed, one that stopped or took too long and one that came out without its pages or font, each logged. */
async function printChecked(
  services: PdfServices,
  document: PrintDocument,
): Promise<Result<Uint8Array, FileFailure>> {
  let pdf: Uint8Array;
  try {
    pdf = await renderPdf(services, document);
  } catch (error) {
    if (!(error instanceof PrintingStopped)) {
      throw error;
    }
    console.error('The PDF could not be printed:', error);
    return failure({ code: 'PRINT_FAILED' });
  }
  if (pdf.length > MAX_PDF_BYTES) {
    return failure({ code: 'TOO_LARGE' });
  }
  if (!isCompletePdf(pdf, document.pages.length)) {
    console.error(
      'The printed PDF lacks pages or the printed font: a file of the interface was not served.',
    );
    return failure({ code: 'PRINT_INCOMPLETE' });
  }
  return success(pdf);
}

/** Writes the PDF kept back for a page, which the user chose to export as it is. */
async function saveHeldPdf(
  held: HeldPdfStore,
  sender: WebContents,
): Promise<BridgeResult<ExportedFile>> {
  const kept = held.get(sender);
  if (kept === undefined) {
    console.error('No PDF was kept back for this window.');
    return failure({ code: 'TASK_FAILED' });
  }
  const written = await writePdf(sender, kept.pdf, kept.name);
  if (written.ok) {
    held.forget(sender);
  }
  return written;
}

/** Writes the document kept back for a page as a PDF made without the browser, in the file worker, as the user chose the lighter PDF, writing it whatever its weight within the size a PDF may have. */
async function exportLighterPdf(
  services: PdfServices,
  held: HeldPdfStore,
  sender: WebContents,
): Promise<BridgeResult<ExportedFile>> {
  const kept = held.get(sender);
  if (kept === undefined) {
    console.error('No PDF was kept back for this window.');
    return failure({ code: 'TASK_FAILED' });
  }
  const made = await services.runTask({
    kind: 'writeDirectPdf',
    document: kept.document,
    fonts: services.fonts,
  });
  if (!made.ok) {
    return made;
  }
  const written = await writePdf(sender, made.value.pdf, kept.name);
  if (written.ok) {
    held.forget(sender);
  }
  return written;
}

/** Returns the paths of the Jost Print files, weights 400, 500 and 600, in the fonts folder of the interface. */
export function printFontsIn(folder: string): PrintFonts {
  return {
    400: join(folder, 'jost-print-400.ttf'),
    500: join(folder, 'jost-print-500.ttf'),
    600: join(folder, 'jost-print-600.ttf'),
  };
}

/** Asks where to write a PDF and writes it safely, a failure of the system being reported as a failed write and a window closed in the meantime as a cancelled export. */
async function writePdf(
  sender: WebContents,
  pdf: Uint8Array,
  name: string,
): Promise<BridgeResult<ExportedFile>> {
  if (sender.isDestroyed()) {
    return closedWhilePrinting();
  }
  const path = await chooseFileToSave(sender, 'pdf', name);
  if (path === null) {
    return failure({ code: 'CANCELLED' });
  }
  try {
    await writeFileSafely(path, pdf);
    return success({ fileName: basename(path) });
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    console.error('The PDF could not be written:', error);
    return failure({ code: 'WRITE_FAILED' });
  }
}

/** Logs that the window or its export closed while its PDF was being made, and cancels the export, nothing being kept for it. */
function closedWhilePrinting(): BridgeResult<never> {
  console.warn('The export closed while its PDF was being made.');
  return failure({ code: 'CANCELLED' });
}

/** Prints a checked document in a hidden window and returns the PDF, the window and its page being given up in every case, and failing when the window ends or printing takes longer than the time allowed. */
export async function renderPdf(
  services: PdfServices,
  document: PrintDocument,
): Promise<Uint8Array> {
  const page = services.pages.hold(printHtml(document));
  let window: BrowserWindow | null = null;
  try {
    window = services.createPrintWindow();
    const pdf = await withTimeout(printIn(window, page.url, document), services.timeoutMs);
    return new Uint8Array(pdf);
  } finally {
    page.release();
    window?.destroy();
  }
}

/** Loads a page in the hidden window and prints it at the size of the paper of the document, failing when the process of the window ends. */
function printIn(window: BrowserWindow, url: string, document: PrintDocument): Promise<Buffer> {
  const size = pageSizeOf(document.paper, document.orientation);
  const gone = new Promise<never>((_resolve, reject) => {
    window.webContents.once('render-process-gone', (_event, details) => {
      reject(new PrintingStopped(`The printing window ended: ${details.reason}.`));
    });
  });
  const printing = window.loadURL(url).then(() =>
    window.webContents.printToPDF({
      pageSize: { width: size.width / POINTS_PER_INCH, height: size.height / POINTS_PER_INCH },
      landscape: false,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      printBackground: true,
      preferCSSPageSize: false,
    }),
  );
  return Promise.race([printing, gone]);
}

/** Waits for a promise, failing once a time has passed without an answer. */
async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new PrintingStopped(`Printing to PDF took more than ${String(milliseconds)} ms.`));
    }, milliseconds);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Tells whether a PDF printed by Chromium declares one page object for each page of its document and embeds the printed font, which every page writes, reading its bytes once without copying them. */
function isCompletePdf(pdf: Uint8Array, pages: number): boolean {
  const bytes = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  return bytes.includes(PRINTED_FONT_MARK) && pageObjectCount(bytes) === pages;
}

/** Counts the objects of a PDF whose type is a page, not the tree of pages that holds them. */
function pageObjectCount(bytes: Buffer): number {
  let count = 0;
  for (let at = bytes.indexOf(TYPE_KEY); at !== -1; at = bytes.indexOf(TYPE_KEY, at + 1)) {
    count += isPageTypeAt(bytes, at + TYPE_KEY.length) ? 1 : 0;
  }
  return count;
}

/** Tells whether the value written after a type key, once its blanks are skipped, names a page. */
function isPageTypeAt(bytes: Buffer, from: number): boolean {
  let at = from;
  while (PDF_WHITESPACE.has(bytes[at] ?? -1)) {
    at += 1;
  }
  return (
    bytes.toString('latin1', at, at + PAGE_TYPE.length) === PAGE_TYPE &&
    bytes[at + PAGE_TYPE.length] !== PLURAL_ENDING
  );
}
