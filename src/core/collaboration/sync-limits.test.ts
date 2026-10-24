import { describe, expect, it, vi } from 'vitest';
import { createSharedDocument } from '../shared/shared-document';
import { project, TEST_DOCUMENT_ID, workTask } from '../testing/project-builder';
import { sessionOn } from '../testing/session-copy';
import { requireParticipantId } from './participants';
import { createHost, type SyncEvent } from './sync';

const limits = vi.hoisted(() => ({ pendingBytes: Number.POSITIVE_INFINITY }));

vi.mock('../limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../limits')>()),
  get MAX_PENDING_UPDATE_BYTES() {
    return limits.pendingBytes;
  },
}));

describe('an update kept back for being incomplete', () => {
  it('is dropped once it would grow past its limit, the refusal told', () => {
    const origin = createSharedDocument(project([workTask('a')]), TEST_DOCUMENT_ID);
    const lea = requireParticipantId('lea');
    const events: SyncEvent[] = [];
    const host = createHost({
      session: sessionOn(origin, 1),
      roster: null,
      tokenDigest: null,
      hostId: requireParticipantId('host'),
      name: 'Camille',
      send: () => undefined,
      report: (event) => events.push(event),
    });
    expect(host.connect(lea, 'Léa', null, null).ok).toBe(true);
    expect(host.setRight(lea, true).ok).toBe(true);
    const guest = sessionOn(origin, 2);
    const task = guest.project().tasks[0];
    if (task === undefined) {
      throw new Error('No task');
    }
    expect(guest.apply({ type: 'putTask', task: { ...task, name: 'First' } }).ok).toBe(true);
    const middle = guest.encodeStateVector();
    expect(guest.apply({ type: 'putTask', task: { ...task, name: 'Second' } }).ok).toBe(true);
    const later = guest.encodeState(middle);
    limits.pendingBytes = later.length - 1;
    events.splice(0);
    host.receive(lea, { kind: 'update', update: later });
    expect(events).toEqual([{ kind: 'refused', from: lea, reason: 'PENDING_TOO_LARGE' }]);
  });
});
