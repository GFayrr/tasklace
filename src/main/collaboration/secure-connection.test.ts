import { describe, expect, it, vi } from 'vitest';
import { requireParticipantId } from '../../core/collaboration/participants';
import { MAX_COLLABORATION_MESSAGE_BYTES, MAX_HANDSHAKE_MILLISECONDS } from '../../core/limits';
import { failure, success } from '../../core/result';
import { openSecureChannel } from '../../core/collaboration/secure/channel';
import { answerHostLink } from '../../core/collaboration/secure/link';
import { zlibCompressor } from '../zlib-compressor';
import { aesGcm, systemRandomBytes } from './aes-gcm';
import {
  acceptGuest,
  connectToHost,
  type ConnectionEnd,
  type SecureConnection,
  type StartTimer,
} from './secure-connection';

const INTRODUCTION = { participantId: requireParticipantId('lea-1'), name: 'Léa' };

interface Side {
  readonly sent: Uint8Array[];
  readonly messages: Uint8Array[];
  readonly ends: ConnectionEnd[];
  readonly closes: number[];
}

/** Starts timers that the test fires by hand. */
function manualTimers() {
  const pending: { milliseconds: number; onEnd: () => void; stopped: boolean }[] = [];
  /** Records a timer instead of starting it. */
  const startTimer: StartTimer = (milliseconds, onEnd) => {
    const timer = { milliseconds, onEnd, stopped: false };
    pending.push(timer);
    return () => {
      timer.stopped = true;
    };
  };
  return {
    startTimer,
    pending,
    fire: () => {
      pending
        .filter((timer) => !timer.stopped)
        .forEach((timer) => {
          timer.onEnd();
        });
    },
  };
}

/** Builds the wire and the events of one side, recording everything. */
function side(): Side & {
  wire: { send: (bytes: Uint8Array) => void; close: (reason: ConnectionEnd) => void };
} {
  const recorded: Side = { sent: [], messages: [], ends: [], closes: [] };
  return {
    ...recorded,
    wire: {
      send: (bytes) => recorded.sent.push(Uint8Array.from(bytes)),
      close: () => recorded.closes.push(1),
    },
  };
}

/** Opens a host and a guest whose wires are handed over by the test. */
function pair(hostCode = 'K7Q4MZ', guestCode = 'K7Q4MZ') {
  const timers = manualTimers();
  const hostSide = side();
  const guestSide = side();
  const joined = vi.fn();
  const opened = vi.fn();
  const host = acceptGuest({
    code: hostCode,
    wire: hostSide.wire,
    startTimer: timers.startTimer,
    randomBytes: systemRandomBytes,
    events: {
      message: (bytes) => hostSide.messages.push(bytes),
      ended: (reason) => hostSide.ends.push(reason),
    },
    joined,
  });
  const guest = connectToHost({
    code: guestCode,
    wire: guestSide.wire,
    startTimer: timers.startTimer,
    randomBytes: systemRandomBytes,
    introduction: INTRODUCTION,
    events: {
      message: (bytes) => guestSide.messages.push(bytes),
      ended: (reason) => guestSide.ends.push(reason),
    },
    opened,
  });
  /** Hands every frame sent so far to the other side, back and forth until both are quiet. */
  const flush = (): void => {
    while (hostSide.sent.length > 0 || guestSide.sent.length > 0) {
      hostSide.sent.splice(0).forEach((bytes) => {
        guest.receive(bytes);
      });
      guestSide.sent.splice(0).forEach((bytes) => {
        host.receive(bytes);
      });
    }
  };
  return { host, guest, hostSide, guestSide, joined, opened, timers, flush };
}

/** Sends a message, failing the test when it is refused. */
function send(connection: SecureConnection, bytes: Uint8Array): void {
  expect(connection.send(bytes)).toEqual(success(null));
}

describe('a secure connection', () => {
  it('opens when both sides use the same code, introduces the guest and carries messages both ways', () => {
    const net = pair();
    net.flush();
    expect(net.joined.mock.calls).toEqual([[INTRODUCTION]]);
    expect(net.opened).toHaveBeenCalledTimes(1);
    send(net.host, Uint8Array.of(1, 2));
    send(net.guest, Uint8Array.of(3));
    net.flush();
    expect([net.guestSide.messages, net.hostSide.messages]).toEqual([
      [Buffer.from([1, 2])],
      [Buffer.from([3])],
    ]);
    expect(net.timers.pending.map((timer) => [timer.milliseconds, timer.stopped])).toEqual([
      [MAX_HANDSHAKE_MILLISECONDS, true],
      [MAX_HANDSHAKE_MILLISECONDS, true],
    ]);
  });

  it('refuses a guest with a wrong code on the side of the host, which closes the wire', () => {
    const net = pair('K7Q4MZ', 'K7Q4MA');
    net.flush();
    expect([net.hostSide.ends, net.hostSide.closes, net.joined.mock.calls]).toEqual([
      ['WRONG_CODE'],
      [1],
      [],
    ]);
    net.host.wireClosed();
    expect(net.hostSide.ends).toEqual(['WRONG_CODE']);
  });

  it('refuses to send before the channel is open', () => {
    const net = pair();
    expect(net.host.send(Uint8Array.of(1))).toEqual(failure('NOT_OPEN'));
    expect(net.guest.send(Uint8Array.of(1))).toEqual(failure('NOT_OPEN'));
  });

  it('ends on the limit of time while opening, and not once open', () => {
    const opening = pair();
    opening.timers.fire();
    expect([opening.hostSide.ends, opening.guestSide.ends]).toEqual([['TIMEOUT'], ['TIMEOUT']]);
    const open = pair();
    open.flush();
    open.timers.fire();
    expect([open.hostSide.ends, open.guestSide.ends]).toEqual([[], []]);
  });

  it('ends on a malformed reply, hello or confirmation', () => {
    const host = pair();
    host.host.receive(Uint8Array.of(1));
    const guest = pair();
    guest.guest.receive(Uint8Array.of(1));
    const confirm = pair();
    confirm.guest.receive(confirm.hostSide.sent.splice(0)[0] ?? new Uint8Array());
    confirm.guest.receive(Uint8Array.of(1));
    expect([host.hostSide.ends, guest.guestSide.ends, confirm.guestSide.ends]).toEqual([
      ['MALFORMED'],
      ['MALFORMED'],
      ['MALFORMED'],
    ]);
  });

  it('ends on a frame that does not authenticate, at the introduction or once open, and then ignores everything', () => {
    const introduction = pair();
    introduction.guest.receive(introduction.hostSide.sent.splice(0)[0] ?? new Uint8Array());
    introduction.host.receive(introduction.guestSide.sent.splice(0)[0] ?? new Uint8Array());
    introduction.host.receive(new Uint8Array(40));
    const open = pair();
    open.flush();
    open.guest.receive(new Uint8Array(40));
    open.guest.receive(new Uint8Array(40));
    expect([introduction.hostSide.ends, open.guestSide.ends]).toEqual([['TAMPERED'], ['TAMPERED']]);
  });

  it('ends on an introduction that is not one', () => {
    const net = pair();
    const guest = answerHostLink(
      net.hostSide.sent.splice(0)[0] ?? new Uint8Array(),
      'K7Q4MZ',
      systemRandomBytes,
    );
    if (!guest.ok) {
      throw new Error(guest.error);
    }
    net.host.receive(guest.value.reply);
    const keys = guest.value.finish(net.hostSide.sent.splice(0)[0] ?? new Uint8Array());
    if (!keys.ok) {
      throw new Error(keys.error);
    }
    const frames = openSecureChannel(keys.value, aesGcm, zlibCompressor).seal(Uint8Array.of(1));
    (frames.ok ? frames.value : []).forEach((frame) => {
      net.host.receive(frame);
    });
    expect([net.hostSide.ends, net.joined.mock.calls]).toEqual([['INVALID_INTRODUCTION'], []]);
  });

  it('ends once when closed, without closing a wire that closed by itself', () => {
    const closed = pair();
    closed.flush();
    closed.host.close();
    closed.host.close();
    const fromWire = pair();
    fromWire.guest.wireClosed();
    expect([
      closed.hostSide.ends,
      closed.hostSide.closes,
      fromWire.guestSide.ends,
      fromWire.guestSide.closes,
    ]).toEqual([['CLOSED'], [1], ['WIRE_CLOSED'], []]);
  });

  it('refuses to send a message above the limit, keeping the connection open', () => {
    const net = pair();
    net.flush();
    expect(net.host.send({ length: MAX_COLLABORATION_MESSAGE_BYTES + 1 } as Uint8Array)).toEqual(
      failure('TOO_LARGE'),
    );
    expect(net.hostSide.ends).toEqual([]);
  });
});
