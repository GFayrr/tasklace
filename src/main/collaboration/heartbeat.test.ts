import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_MILLISECONDS } from '../../core/limits';
import { watchHeartbeat, type HeartbeatSocket } from './heartbeat';
import type { StartTimer } from './secure-connection';

/** Builds a socket that records what the heartbeat does to it, with timers the test fires by hand. */
function watched() {
  const done: string[] = [];
  const timers: { readonly milliseconds: number; readonly fire: () => void; stopped: boolean }[] =
    [];
  const emitter = new EventEmitter();
  const socket: HeartbeatSocket = {
    ping: () => {
      done.push('ping');
    },
    terminate: () => {
      done.push('terminate');
    },
    on: (event: string, listener: (...values: unknown[]) => void) => {
      emitter.on(event, listener);
      return socket;
    },
  } as HeartbeatSocket;
  /** Records each timer the heartbeat starts, without starting any. */
  const startTimer: StartTimer = (milliseconds, onEnd) => {
    const timer = { milliseconds, fire: onEnd, stopped: false };
    timers.push(timer);
    return () => {
      timer.stopped = true;
    };
  };
  watchHeartbeat(socket, startTimer);
  /** Fires the latest timer the heartbeat started. */
  const beat = (): void => {
    timers.at(-1)?.fire();
  };
  return { done, timers, beat, emit: (event: string) => emitter.emit(event) };
}

describe('the heartbeat of a connection', () => {
  it('pings at a steady pace while the other end answers each ping', () => {
    const socket = watched();
    socket.beat();
    socket.emit('pong');
    socket.beat();
    socket.emit('pong');
    socket.beat();
    expect(socket.done).toEqual(['ping', 'ping', 'ping']);
    expect(socket.timers.map((timer) => timer.milliseconds)).toEqual([
      HEARTBEAT_MILLISECONDS,
      HEARTBEAT_MILLISECONDS,
      HEARTBEAT_MILLISECONDS,
      HEARTBEAT_MILLISECONDS,
    ]);
  });

  it('counts a message as an answer', () => {
    const socket = watched();
    socket.beat();
    socket.emit('message');
    socket.beat();
    expect(socket.done).toEqual(['ping', 'ping']);
  });

  it('cuts a socket silent for two pings, once what already arrived was read, logs it and pings no more', () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const socket = watched();
    socket.beat();
    socket.beat();
    socket.beat();
    expect(socket.done).toEqual(['ping', 'ping']);
    socket.beat();
    expect([socket.done, warnings.mock.calls]).toEqual([
      ['ping', 'ping', 'terminate'],
      [['A connection to the shared plan stayed silent and was cut.']],
    ]);
    expect(socket.timers.map((timer) => timer.milliseconds)).toEqual([
      HEARTBEAT_MILLISECONDS,
      HEARTBEAT_MILLISECONDS,
      HEARTBEAT_MILLISECONDS,
      0,
    ]);
  });

  it('keeps a socket whose answer was waiting while this process was busy', () => {
    const socket = watched();
    socket.beat();
    socket.beat();
    socket.beat();
    socket.emit('pong');
    socket.beat();
    expect(socket.done).toEqual(['ping', 'ping', 'ping']);
  });

  it('stops beating once the socket closes', () => {
    const socket = watched();
    socket.beat();
    socket.emit('close');
    expect(socket.timers.map((timer) => timer.stopped)).toEqual([false, true]);
  });
});
