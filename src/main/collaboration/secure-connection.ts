import {
  openSecureChannel,
  type ChannelBreak,
  type SealRefusal,
  type SecureChannel,
} from '../../core/collaboration/secure/channel';
import type { SessionKeys } from '../../core/collaboration/secure/cpace';
import {
  answerHostLink,
  encodeIntroduction,
  readIntroduction,
  startHostLink,
  type Introduction,
  type LinkRefusal,
} from '../../core/collaboration/secure/link';
import { zlibCompressor } from '../zlib-compressor';
import { MAX_HANDSHAKE_MILLISECONDS } from '../../core/limits';
import { failure, success, type Result } from '../../core/result';
import { aesGcm } from './aes-gcm';

export interface Wire {
  readonly send: (bytes: Uint8Array) => void;
  readonly close: (reason: ConnectionEnd) => void;
}

export type StartTimer = (milliseconds: number, onEnd: () => void) => () => void;

export type ConnectionEnd =
  LinkRefusal | ChannelBreak | 'TIMEOUT' | 'INVALID_INTRODUCTION' | 'WIRE_CLOSED' | 'CLOSED';

export interface ConnectionEvents {
  readonly message: (bytes: Uint8Array) => void;
  readonly ended: (reason: ConnectionEnd) => void;
}

export interface SecureConnection {
  readonly receive: (bytes: Uint8Array) => void;
  readonly send: (message: Uint8Array) => Result<null, SealRefusal | 'NOT_OPEN'>;
  readonly wireClosed: () => void;
  readonly close: () => void;
}

interface Common {
  readonly wire: Wire;
  readonly startTimer: StartTimer;
  readonly events: ConnectionEvents;
  readonly randomBytes: (count: number) => Uint8Array;
  readonly code: string;
}

type Step = (bytes: Uint8Array) => void;

/** Holds what both ends of a connection share: the channel once open, the limit on the time to open it, and an end that happens once. */
function connectionCore(common: Common) {
  let channel: SecureChannel | null = null;
  let isOver = false;
  const stopTimer = common.startTimer(MAX_HANDSHAKE_MILLISECONDS, () => {
    end('TIMEOUT');
  });
  /** Ends the connection once, closing the wire unless it already closed. */
  const end = (reason: ConnectionEnd): void => {
    if (isOver) {
      return;
    }
    isOver = true;
    channel = null;
    stopTimer();
    if (reason !== 'WIRE_CLOSED') {
      common.wire.close(reason);
    }
    common.events.ended(reason);
  };
  return {
    end,
    isOver: () => isOver,
    open: (keys: SessionKeys): SecureChannel => {
      channel = openSecureChannel(keys, aesGcm, zlibCompressor);
      return channel;
    },
    opened: () => {
      stopTimer();
    },
    send: (message: Uint8Array): Result<null, SealRefusal | 'NOT_OPEN'> => {
      if (channel === null) {
        return failure('NOT_OPEN');
      }
      const frames = channel.seal(message);
      if (!frames.ok) {
        return frames;
      }
      frames.value.forEach((frame) => {
        common.wire.send(frame);
      });
      return success(null);
    },
    /** Opens one frame of the channel, ending the connection when the channel breaks, and gives the message it completes, if any. */
    openFrame: (open: SecureChannel, bytes: Uint8Array): Uint8Array | null => {
      const opened = open.open(bytes);
      if (!opened.ok) {
        end(opened.error);
        return null;
      }
      return opened.value;
    },
  };
}

/** Gives each complete message of the open channel to the events of the connection. */
function openStepOf(
  core: ReturnType<typeof connectionCore>,
  channel: SecureChannel,
  events: ConnectionEvents,
): Step {
  return (bytes) => {
    const message = core.openFrame(channel, bytes);
    if (message !== null) {
      events.message(message);
    }
  };
}

/** Builds the connection object from its current step, ignoring anything once it is over. */
function connectionOf(
  core: ReturnType<typeof connectionCore>,
  current: () => Step,
): SecureConnection {
  return {
    receive: (bytes) => {
      if (!core.isOver()) {
        current()(bytes);
      }
    },
    send: core.send,
    wireClosed: () => {
      core.end('WIRE_CLOSED');
    },
    close: () => {
      core.end('CLOSED');
    },
  };
}

/** Accepts a guest on the side of the host: sends the hello, checks the proof of the code, then waits for the introduction before telling who joined, a wrong code being told apart so that the host can count it. */
export function acceptGuest(
  common: Common & { readonly joined: (introduction: Introduction) => void },
): SecureConnection {
  const core = connectionCore(common);
  const link = startHostLink(common.code, common.randomBytes);
  /** Reads the introduction of the guest, the first message of the channel. */
  const introductionStepOf =
    (channel: SecureChannel): Step =>
    (bytes) => {
      const message = core.openFrame(channel, bytes);
      if (message === null) {
        return;
      }
      const introduction = readIntroduction(message);
      if (introduction === null) {
        core.end('INVALID_INTRODUCTION');
        return;
      }
      step = openStepOf(core, channel, common.events);
      core.opened();
      common.joined(introduction);
    };
  /** Checks the share and the proof of the guest and answers with the proof of the host. */
  const replyStep: Step = (bytes) => {
    const answered = link.answer(bytes);
    if (!answered.ok) {
      core.end(answered.error);
      return;
    }
    step = introductionStepOf(core.open(answered.value.keys));
    common.wire.send(answered.value.confirm);
  };
  let step = replyStep;
  common.wire.send(link.hello);
  return connectionOf(core, () => step);
}

/** Joins a host on the side of a guest: answers its hello, checks its proof, then introduces the guest on the open channel. */
export function connectToHost(
  common: Common & { readonly introduction: Introduction; readonly opened: () => void },
): SecureConnection {
  const core = connectionCore(common);
  /** Answers the hello of the host with the share and the proof of the guest. */
  const helloStep: Step = (bytes) => {
    const guest = answerHostLink(bytes, common.code, common.randomBytes);
    if (!guest.ok) {
      core.end(guest.error);
      return;
    }
    step = (confirm) => {
      const keys = guest.value.finish(confirm);
      if (!keys.ok) {
        core.end(keys.error);
        return;
      }
      const channel = core.open(keys.value);
      step = openStepOf(core, channel, common.events);
      core.opened();
      const introduced = core.send(encodeIntroduction(common.introduction));
      if (!introduced.ok) {
        core.end(introduced.error === 'NOT_OPEN' ? 'BROKEN' : introduced.error);
        return;
      }
      common.opened();
    };
    common.wire.send(guest.value.reply);
  };
  let step = helloStep;
  return connectionOf(core, () => step);
}
