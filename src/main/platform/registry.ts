import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSystemError } from '../stored-files';

export type RegistryAction = 'export' | 'import' | 'delete';

export interface ToolOutcome {
  readonly exitCode: number | 'stopped';
  readonly errorOutput: string;
}

export type RunRegistryTool = (args: readonly string[]) => Promise<ToolOutcome>;

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
const NOT_DONE = 1;
const WITNESS_KEY = 'HKEY_CURRENT_USER\\Software';
const REGISTRY_TOOL_MILLISECONDS = 16_384;
const MAX_ERROR_OUTPUT_LENGTH = 1_024;
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows';

/** Runs the registry tool of Windows from the system folder, never through a shell nor the search path, giving its exit code, or that it was stopped, with what it wrote as an error, a tool the system cannot start being reported as a system error. */
export function runRegistryTool(systemRoot: string | undefined): RunRegistryTool {
  const tool = join(systemRoot ?? DEFAULT_SYSTEM_ROOT, 'System32', 'reg.exe');
  return (args) =>
    new Promise<ToolOutcome>((resolve, reject) => {
      execFile(
        tool,
        args,
        { windowsHide: true, timeout: REGISTRY_TOOL_MILLISECONDS },
        (error: Error | null, _output: unknown, errorOutput: unknown) => {
          const text = typeof errorOutput === 'string' ? errorOutput : '';
          const written = text.trim().slice(0, MAX_ERROR_OUTPUT_LENGTH);
          if (error === null) {
            resolve({ exitCode: SUCCESS, errorOutput: written });
            return;
          }
          if (isSystemError(error)) {
            reject(error);
            return;
          }
          const code: unknown = Reflect.get(error, 'code');
          resolve({ exitCode: typeof code === 'number' ? code : 'stopped', errorOutput: written });
        },
      );
    });
}

/** Writes the lines of a registry file with the byte order mark and the header the registry tool expects, the file being written in UTF-16 when imported. */
export function registryFileText(lines: readonly string[]): string {
  return [BYTE_ORDER_MARK + REGISTRY_FILE_HEADER, '', ...lines, ''].join(LINE_END);
}

/** Writes a text as a quoted value of a registry file, its backslashes and quotes escaped. */
export function registryString(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** Reads a named or default text value of one key from an exported registry file, never from another key it holds, or returns null when that key does not hold it as a text. */
export function readRegistryString(
  exported: string,
  key: string,
  name: string | null,
): string | null {
  const start = name === null ? '@=' : `${registryString(name)}=`;
  const line = linesOfKey(exported, key).find((text) => text.startsWith(start));
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(line?.slice(start.length) ?? '');
  return match === null ? null : (match[1] ?? '').replaceAll(/\\(.)/g, '$1');
}

/** Reads a named number value of one key from an exported registry file, or returns null when that key does not hold it as a number. */
export function readRegistryNumber(exported: string, key: string, name: string): number | null {
  const start = `${registryString(name)}=dword:`;
  const line = linesOfKey(exported, key).find((text) => text.startsWith(start));
  const digits = line?.slice(start.length) ?? '';
  return /^[0-9a-f]{8}$/.test(digits) ? Number.parseInt(digits, 16) : null;
}

/** Gives the lines of the values of one key in an exported registry file, from its heading to the next one, the name of a key being compared without regard to case as Windows does. */
function linesOfKey(exported: string, key: string): readonly string[] {
  const lines = exported.split(/\r?\n/);
  const heading = `[${key}]`.toLowerCase();
  const start = lines.findIndex((line) => line.toLowerCase() === heading);
  if (start === -1) {
    return [];
  }
  const length = lines.slice(start + 1).findIndex((line) => line.startsWith('['));
  return lines.slice(start + 1, length === -1 ? undefined : start + 1 + length);
}

/** Reads and writes keys of the registry of the current user through the registry tool and files removed once used, a key counting as missing only when the tool still reads a key that always exists. */
export function createRegistry(run: RunRegistryTool, folder: string): Registry {
  /** Gives a path for a registry file of one use, so that two uses never share a file. */
  const fileOf = (): string => join(folder, `registry-${randomUUID()}.reg`);
  /** Tells whether a refusal of the tool means the key is missing, which holds only when the tool reads a key that always exists, throwing otherwise. */
  const confirmMissing = async (action: RegistryAction, outcome: ToolOutcome): Promise<void> => {
    if ((await run(['query', WITNESS_KEY])).exitCode !== SUCCESS) {
      throw new RegistryToolError(action, outcome);
    }
  };
  /** Exports a key into a file of its own and reads it, giving null for a key that does not exist. */
  const exportKey = async (key: string): Promise<string | null> => {
    const file = fileOf();
    try {
      const outcome = await run(['export', key, file, '/y']);
      if (outcome.exitCode === NOT_DONE) {
        await confirmMissing('export', outcome);
        return null;
      }
      expectSuccess('export', outcome);
      return (await readFile(file, REGISTRY_ENCODING)).replace(BYTE_ORDER_MARK, '');
    } finally {
      await removeFile(file);
    }
  };
  return {
    exportKey,
    importText: async (text) => {
      const file = fileOf();
      try {
        await writeFile(file, text, REGISTRY_ENCODING);
        expectSuccess('import', await run(['import', file]));
      } finally {
        await removeFile(file);
      }
    },
    deleteKey: async (key) => {
      const outcome = await run(['delete', key, '/f']);
      if (outcome.exitCode === NOT_DONE) {
        await confirmMissing('delete', outcome);
        return;
      }
      expectSuccess('delete', outcome);
      if ((await exportKey(key)) !== null) {
        throw new RegistryToolError('delete', {
          exitCode: SUCCESS,
          errorOutput: 'the key is still there',
        });
      }
    },
  };
}

/** Throws when the registry tool did not succeed, naming what it was asked. */
function expectSuccess(action: RegistryAction, outcome: ToolOutcome): void {
  if (outcome.exitCode !== SUCCESS) {
    throw new RegistryToolError(action, outcome);
  }
}

/** Removes a registry file once used, a file that cannot be removed being only logged since it holds nothing secret. */
async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true }).catch((error: unknown) => {
    console.warn(`The registry file ${file} could not be removed:`, error);
  });
}

export class RegistryToolError extends Error {
  /** Tells that the registry tool of Windows did not do what it was asked, with how it ended and what it wrote. */
  constructor(
    readonly action: RegistryAction,
    readonly outcome: ToolOutcome,
  ) {
    const ending =
      outcome.exitCode === 'stopped'
        ? 'it was stopped'
        : `it ended with the code ${String(outcome.exitCode)}`;
    const written = outcome.errorOutput === '' ? '' : ` (${outcome.errorOutput})`;
    super(`The registry tool could not ${action}: ${ending}${written}.`);
    this.name = 'RegistryToolError';
  }
}
