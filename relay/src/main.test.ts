import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectTo, createFrame } from './testing/relay-client.ts';
import { ROOM_KEYS, temporaryFolder } from './testing/relay-records.ts';

const MAIN = path.join(import.meta.dirname, 'main.ts');
const STARTED = /port (\d+)\./;

let folder: string;
let removeFolder: () => Promise<void>;

beforeEach(async () => {
  ({ folder, remove: removeFolder } = await temporaryFolder());
});

afterEach(async () => {
  await removeFolder();
});

/** Runs the relay as its own Node process, as a server runs it, giving what it wrote and how it ended. */
function runRelay(environment: Record<string, string>) {
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env['PATH'] ?? '', RELAY_DATA_DIR: folder, ...environment },
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const ended = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });
  const port = new Promise<number>((resolve, reject) => {
    child.stdout.on('data', () => {
      const found = STARTED.exec(output);
      if (found?.[1] !== undefined) {
        resolve(Number(found[1]));
      }
    });
    void ended.then(() => {
      reject(new Error(output));
    });
  });
  port.catch(() => undefined);
  return { child, port, ended, output: () => output };
}

describe('the relay run by Node itself', () => {
  it('starts from its environment, lets a member create a room and stops cleanly when asked to', async () => {
    const relay = runRelay({ RELAY_PORT: '0' });
    const port = await relay.port;
    const member = await connectTo(port);
    member.send(createFrame(ROOM_KEYS));
    const welcome = await member.next();
    relay.child.kill('SIGTERM');
    expect([welcome?.valueOf(), await relay.ended, await member.closed]).toEqual([
      { type: 'welcome', member: 1, verifyKey: ROOM_KEYS.verifyKey, members: [] },
      0,
      1001,
    ]);
  });

  it('refuses to start with a wrong setting, telling which', async () => {
    const relay = runRelay({ RELAY_PORT: 'eighty' });
    expect([await relay.ended, relay.output()]).toEqual([
      1,
      'RELAY_PORT must be a whole number from 0 to 65535.\n',
    ]);
  });

  it('tells when it cannot start', async () => {
    const relay = runRelay({
      RELAY_PORT: '0',
      RELAY_TLS_CERT: 'missing.pem',
      RELAY_TLS_KEY: 'missing.pem',
    });
    expect([await relay.ended, relay.output().split('\n')[0]]).toEqual([
      1,
      "The relay could not start: Error: ENOENT: no such file or directory, open 'missing.pem'",
    ]);
  });
});
