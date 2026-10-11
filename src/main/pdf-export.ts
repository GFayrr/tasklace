import { basename, join } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { MAX_PDF_BYTES } from '../core/limits';
import { pageSizeOf } from '../core/print/paper';
import type { PrintDocument } from '../core/print/print-document';
import { printHtml } from '../core/print/print-html';
import { readPrintDocument } from '../core/print/read-print-document';
import { failure, success } from '../core/result';
import {
  IPC_CHANNELS,
  type BridgeResult,
  type ChannelAnswers,
  type ExportedFile,
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

interface HeldPdf {
  readonly pdf: Uint8Array;
  readonly name: string;
  readonly document: PrintDocument;
}

export const PDF_RENDER_TIMEOUT_MS = 300_000;
export const PDF_GUARD_BYTES_PER_PAGE = 50 * 1_024;
export const PDF_GUARD_MIN_PAGES = 10;

const POINTS_PER_INCH = 72;
const held = new WeakMap<WebContents, HeldPdf>();

/** Answers the bridge requests that print a plan to PDF and that write a PDF kept back for being heavier than expected, as it is or made lighter without the browser. */
export function registerPdfHandlers(services: PdfServices): void {
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
    exportPdf(services, event.sender, document, name),
  );
  handle(IPC_CHANNELS.saveHeldPdf, (event) => saveHeldPdf(event.sender));
  handle(IPC_CHANNELS.exportLighterPdf, (event) => exportLighterPdf(services, event.sender));
}

/** Prints a document sent by a page to PDF once it is checked, keeping the PDF back when it weighs more than 500 KB for 10 pages, never less than 500 KB, so that the page can offer a choice, and otherwise asking where to write it. */
async function exportPdf(
  services: PdfServices,
  sender: WebContents,
  documentValue: unknown,
  nameValue: unknown,
): Promise<BridgeResult<PdfExport>> {
  held.delete(sender);
  const name = readSuggestedName(nameValue) ?? refuseMessage();
  const read = readPrintDocument(documentValue);
  if (!read.ok) {
    console.error('The document to print was refused:', read.error);
    return failure({ code: 'TASK_FAILED' });
  }
  const pdf = await renderPdf(services, read.value);
  if (pdf.length > MAX_PDF_BYTES) {
    return failure({ code: 'TOO_LARGE' });
  }
  const pages = read.value.pages.length;
  if (pdf.length > PDF_GUARD_BYTES_PER_PAGE * Math.max(pages, PDF_GUARD_MIN_PAGES)) {
    held.set(sender, { pdf, name, document: read.value });
    return success({ kind: 'heavy', bytes: pdf.length, pages });
  }
  const written = await writePdf(sender, pdf, name);
  return written.ok ? success({ kind: 'exported', fileName: written.value.fileName }) : written;
}

/** Writes the PDF kept back for a page, which the user chose to export as it is. */
async function saveHeldPdf(sender: WebContents): Promise<BridgeResult<ExportedFile>> {
  const kept = held.get(sender);
  if (kept === undefined) {
    console.error('No PDF was kept back for this window.');
    return failure({ code: 'TASK_FAILED' });
  }
  const written = await writePdf(sender, kept.pdf, kept.name);
  if (written.ok) {
    held.delete(sender);
  }
  return written;
}

/** Writes the document kept back for a page as a PDF made without the browser, in the file worker, as the user chose the lighter PDF, writing it whatever its size. */
async function exportLighterPdf(
  services: PdfServices,
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
    held.delete(sender);
  }
  return written;
}

/** Returns the files of the printed weights of Jost in the fonts folder of the interface. */
export function printFontsIn(folder: string): PrintFonts {
  return {
    400: join(folder, 'jost-print-400.ttf'),
    500: join(folder, 'jost-print-500.ttf'),
    600: join(folder, 'jost-print-600.ttf'),
  };
}

/** Asks where to write a PDF and writes it safely, a failure of the system being reported as a failed write. */
async function writePdf(
  sender: WebContents,
  pdf: Uint8Array,
  name: string,
): Promise<BridgeResult<ExportedFile>> {
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

/** Prints a checked document in a hidden window and returns the PDF, the window and its page being given up in every case, and failing when printing takes longer than the time allowed. */
export async function renderPdf(
  services: PdfServices,
  document: PrintDocument,
): Promise<Uint8Array> {
  const page = services.pages.hold(printHtml(document));
  const window = services.createPrintWindow();
  try {
    const size = pageSizeOf(document.paper, document.orientation);
    const printing = window.loadURL(page.url).then(() =>
      window.webContents.printToPDF({
        pageSize: { width: size.width / POINTS_PER_INCH, height: size.height / POINTS_PER_INCH },
        landscape: false,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        printBackground: true,
        preferCSSPageSize: false,
      }),
    );
    const pdf = await withTimeout(printing, services.timeoutMs);
    return new Uint8Array(pdf);
  } finally {
    page.release();
    window.destroy();
  }
}

/** Waits for a promise, failing with an error once a time has passed without an answer. */
async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Printing to PDF took more than ${String(milliseconds)} ms.`));
    }, milliseconds);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}
