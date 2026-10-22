import { describe, expect, it, vi } from 'vitest';
import { requireParticipantId } from '../../core/collaboration/participants';
import { systemRandomBytes } from './aes-gcm';
import { acceptGuest, connectToHost, type ConnectionEnd } from './secure-connection';

vi.mock('../../core/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/limits')>()),
  MAX_CHANNEL_FRAMES: 0,
}));

describe('a secure connection whose channel cannot seal', () => {
  it('ends the guest when its introduction cannot be sealed, without telling it opened', () => {
    const toGuest: Uint8Array[] = [];
    const toHost: Uint8Array[] = [];
    const ends: ConnectionEnd[] = [];
    const opened = vi.fn();
    const common = {
      startTimer: () => () => undefined,
      randomBytes: systemRandomBytes,
    };
    const host = acceptGuest({
      ...common,
      secrets: { code: 'K7Q4MZ', planKey: new Uint8Array(32) },
      wire: { send: (bytes) => toGuest.push(bytes), close: () => undefined },
      events: { message: () => undefined, planKey: null, ended: () => undefined },
      joined: () => undefined,
    });
    const guest = connectToHost({
      ...common,
      secret: { kind: 'code', code: 'K7Q4MZ' },
      wire: { send: (bytes) => toHost.push(bytes), close: () => undefined },
      events: {
        message: () => undefined,
        planKey: () => undefined,
        ended: (reason) => ends.push(reason),
      },
      introduction: {
        participantId: requireParticipantId('lea'),
        name: 'Léa',
        token: 'ab'.repeat(32),
        endpoint: { addresses: [], port: 47_313 },
      },
      opened,
    });
    guest.receive(toGuest.splice(0)[0] ?? new Uint8Array());
    host.receive(toHost.splice(0)[0] ?? new Uint8Array());
    guest.receive(toGuest.splice(0)[0] ?? new Uint8Array());
    expect([ends, opened.mock.calls]).toEqual([['WORN_OUT'], []]);
  });
});
