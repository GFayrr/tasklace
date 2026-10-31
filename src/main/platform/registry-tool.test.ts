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
}));

vi.mock('node:child_process', () => ({
  execFile: (
    tool: string,
    args: readonly string[],
    options: unknown,
    done: (error: Error | null) => void,
  ) => {
    started.calls.push({ tool, args, options });
    done(started.error);
  },
}));

afterEach(() => {
  started.calls.length = 0;
  started.error = null;
});

describe('runRegistryTool, on every system', () => {
  it('starts the tool of the system folder, the folder of Windows by default, hidden and with a time limit', async () => {
    expect(await runRegistryTool(undefined)(['export', 'K'])).toBe(0);
    expect(await runRegistryTool('E:\\Windows')(['delete', 'K', '/f'])).toBe(0);
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

  it('gives the exit code of a tool that failed, -1 for a tool stopped for taking too long, and rejects a tool the system cannot start', async () => {
    const run = runRegistryTool(undefined);
    started.error = Object.assign(new Error('Command failed'), { code: 1 });
    expect(await run(['export', 'K'])).toBe(1);
    started.error = Object.assign(new Error('Command failed'), { code: null, killed: true });
    expect(await run(['export', 'K'])).toBe(-1);
    const missing = Object.assign(new Error('spawn reg.exe ENOENT'), { code: 'ENOENT' });
    started.error = missing;
    await expect(run(['export', 'K'])).rejects.toBe(missing);
  });
});
