import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRegistryTool } from './registry';

const started = vi.hoisted(() => ({
  calls: [] as {
    readonly tool: string;
    readonly args: readonly string[];
    readonly options: unknown;
  }[],
  error: null as Error | null,
  errorOutput: undefined as string | undefined,
}));

vi.mock('node:child_process', () => ({
  execFile: (
    tool: string,
    args: readonly string[],
    options: unknown,
    done: (error: Error | null, output: unknown, errorOutput: unknown) => void,
  ) => {
    started.calls.push({ tool, args, options });
    done(started.error, '', started.errorOutput);
  },
}));

afterEach(() => {
  started.calls.length = 0;
  started.error = null;
  started.errorOutput = undefined;
});

describe('runRegistryTool, on every system', () => {
  it('starts the tool of the system folder, the folder of Windows by default, hidden and with a time limit', async () => {
    expect(await runRegistryTool(undefined)(['export', 'K'])).toEqual({
      exitCode: 0,
      errorOutput: '',
    });
    expect(await runRegistryTool('E:\\Windows')(['delete', 'K', '/f'])).toEqual({
      exitCode: 0,
      errorOutput: '',
    });
    expect(started.calls).toEqual([
      {
        tool: join('C:\\Windows', 'System32', 'reg.exe'),
        args: ['export', 'K'],
        options: { windowsHide: true, timeout: 16_384 },
      },
      {
        tool: join('E:\\Windows', 'System32', 'reg.exe'),
        args: ['delete', 'K', '/f'],
        options: { windowsHide: true, timeout: 16_384 },
      },
    ]);
  });

  it('gives the exit code of a tool that failed with what it wrote, cut at its limit, that it was stopped when it took too long, and rejects a tool the system cannot start', async () => {
    const run = runRegistryTool(undefined);
    started.error = Object.assign(new Error('Command failed'), { code: 1 });
    started.errorOutput = `  ERROR: ${'x'.repeat(2_000)}\r\n`;
    expect(await run(['export', 'K'])).toEqual({
      exitCode: 1,
      errorOutput: `ERROR: ${'x'.repeat(1_017)}`,
    });
    started.error = Object.assign(new Error('Command failed'), { code: null, killed: true });
    started.errorOutput = undefined;
    expect(await run(['export', 'K'])).toEqual({ exitCode: 'stopped', errorOutput: '' });
    const missing = Object.assign(new Error('spawn reg.exe ENOENT'), { code: 'ENOENT' });
    started.error = missing;
    await expect(run(['export', 'K'])).rejects.toBe(missing);
  });
});
