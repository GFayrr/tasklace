import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSystemError } from '../stored-files';

export type RunRegistryTool = (args: readonly string[]) => Promise<number>;

export interface Registry {
  readonly exportKey: (key: string) => Promise<string | null>;
  readonly importText: (text: string) => Promise<void>;
  readonly deleteKey: (key: string) => Promise<void>;
}

const REGISTRY_FILE_HEADER = 'Windows Registry Editor Version 5.00';
const BYTE_ORDER_MARK = '\ufeff';
const REGISTRY_ENCODING = 'utf16le';
const LINE_END = '\r\n';
const SUCCESS = 0;
const MISSING_KEY = 1;
const STOPPED = -1;
const REGISTRY_TOOL_MILLISECONDS = 16_384;
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows';

/** Runs the registry tool of Windows from the system folder, never through a shell nor the search path, giving its exit code, or -1 when it was stopped for taking too long, a tool the system cannot start being reported as a system error. */
export function runRegistryTool(systemRoot: string | undefined): RunRegistryTool {
  const tool = join(systemRoot ?? DEFAULT_SYSTEM_ROOT, 'System32', 'reg.exe');
  return (args) =>
    new Promise<number>((resolve, reject) => {
      execFile(
        tool,
        args,
        { windowsHide: true, timeout: REGISTRY_TOOL_MILLISECONDS },
        (error: Error | null) => {
          if (error === null) {
            resolve(SUCCESS);
            return;
          }
          if (isSystemError(error)) {
            reject(error);
            return;
          }
          const code: unknown = Reflect.get(error, 'code');
          resolve(typeof code === 'number' ? code : STOPPED);
        },
      );
    });
}

/** Writes the lines of a registry file the way the registry tool reads it, in UTF-16 with its header. */
export function registryFileText(lines: readonly string[]): string {
  return [BYTE_ORDER_MARK + REGISTRY_FILE_HEADER, '', ...lines, ''].join(LINE_END);
}

/** Writes a text as a quoted value of a registry file, its backslashes and quotes escaped. */
export function registryString(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** Reads a named or default text value from an exported registry file, or returns null when the file does not hold it as a text. */
export function readRegistryString(exported: string, name: string | null): string | null {
  const start = name === null ? '@=' : `${registryString(name)}=`;
  const line = exported.split(/\r?\n/).find((text) => text.startsWith(start));
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(line?.slice(start.length) ?? '');
  return match === null ? null : (match[1] ?? '').replaceAll(/\\(.)/g, '$1');
}

/** Reads a named number value from an exported registry file, or returns null when the file does not hold it as a number. */
export function readRegistryNumber(exported: string, name: string): number | null {
  const start = `${registryString(name)}=dword:`;
  const line = exported.split(/\r?\n/).find((text) => text.startsWith(start));
  const digits = line?.slice(start.length) ?? '';
  return /^[0-9a-f]{8}$/.test(digits) ? Number.parseInt(digits, 16) : null;
}

/** Reads and writes keys of the registry of the current user through the registry tool and files in a folder of Tasklace, which are removed once read. */
export function createRegistry(run: RunRegistryTool, folder: string): Registry {
  /** Gives a path for a registry file of one use, so that two uses never share a file. */
  const fileOf = (): string => join(folder, `registry-${randomUUID()}.reg`);
  return {
    exportKey: async (key) => {
      const file = fileOf();
      try {
        const code = await run(['export', key, file, '/y']);
        if (code === MISSING_KEY) {
          return null;
        }
        expectSuccess(code, 'export');
        return (await readFile(file, REGISTRY_ENCODING)).replace(BYTE_ORDER_MARK, '');
      } finally {
        await removeFile(file);
      }
    },
    importText: async (text) => {
      const file = fileOf();
      try {
        await writeFile(file, text, REGISTRY_ENCODING);
        expectSuccess(await run(['import', file]), 'import');
      } finally {
        await removeFile(file);
      }
    },
    deleteKey: async (key) => {
      const code = await run(['delete', key, '/f']);
      if (code !== MISSING_KEY) {
        expectSuccess(code, 'delete');
      }
    },
  };
}

/** Throws when the registry tool did not succeed, naming what it was asked. */
function expectSuccess(code: number, action: string): void {
  if (code !== SUCCESS) {
    throw new RegistryToolError(action, code);
  }
}

/** Removes a registry file once used, a file that cannot be removed being only logged since it holds nothing secret. */
async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true }).catch((error: unknown) => {
    console.warn(`The registry file ${file} could not be removed:`, error);
  });
}

export class RegistryToolError extends Error {
  /** Tells that the registry tool of Windows refused what it was asked, with its exit code. */
  constructor(
    readonly action: string,
    readonly exitCode: number,
  ) {
    super(`The registry tool could not ${action}: it ended with the code ${String(exitCode)}.`);
    this.name = 'RegistryToolError';
  }
}
