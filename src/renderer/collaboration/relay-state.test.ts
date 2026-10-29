import { testShownLink } from '../../core/testing/secrets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeMessage, readMessage } from '../../core/collaboration/messages';
import type { RelayDelivery, RelayOutgoing } from '../../core/collaboration/relay/relay-member';
import { failure, success } from '../../core/result';
import { createSharedDocument } from '../../core/shared/shared-document';
import { openSharedSessionFromState, type SharedSession } from '../../core/shared/shared-session';
import {
  link,
  project,
  TEST_DOCUMENT_ID,
  testId,
  workTask,
} from '../../core/testing/project-builder';
import { sessionOn } from '../../core/testing/session-copy';
import { seededRandom } from '../../core/testing/test-crypto';
import type {
  BridgeResult,
  OpenedProject,
  RelayJoined,
  RelayLinks,
  RelayReopened,
  ShownRelayLinks,
} from '../../preload/bridge-contract';
import { isRelayEvent, RelayState, type RelayBridge } from './relay-state.svelte';

const ORIGIN = createSharedDocument(project([workTask('a'), workTask('b')]), TEST_DOCUMENT_ID);
const BOTH_LINKS: ShownRelayLinks = {
  edit: testShownLink('tasklace://relay.example.org/#e1.Hq7Lm2…'),
  view: testShownLink('tasklace://relay.example.org/#v1.P0dX8w…'),
};
const VIEW_LINK: ShownRelayLinks = { edit: null, view: BOTH_LINKS.view };
const LINKS: RelayLinks = { shown: BOTH_LINKS, relay: 'relay.example.org', kept: true };
const NEW_LINKS: RelayLinks = {
  ...LINKS,
  shown: { edit: testShownLink('tasklace://relay.example.org/#e1.Zk3Rt9…'), view: BOTH_LINKS.view },
};
const DONE: BridgeResult<null> = { ok: true, value: null };

/** Renames a task of a session. */
function rename(session: SharedSession, id: string, name: string): void {
  const task = session.project().tasks.find((candidate) => candidate.id === id);
  if (task === undefined) {
    throw new Error(`No task ${id}`);
  }
  session.apply({ type: 'putTask', task: { ...task, name } });
}

/** Gives the name of a task of a session. */
function nameOf(session: SharedSession | null, id: string): string | undefined {
  return session?.project().tasks.find((task) => task.id === id)?.name;
}

/** Gives the plan a whole-plan message holds, merged into a copy of the original plan. */
function planOf(outgoing: RelayOutgoing | undefined): SharedSession {
  const copy = sessionOn(ORIGIN, 99);
  const read = outgoing?.kind === 'message' ? readMessage(outgoing.message.bytes) : null;
  if (read?.ok && read.value.kind === 'update') {
    copy.merge(read.value.update);
  }
  return copy;
}

/** Gives the change another member made, as the relay passes it on. */
function changeOfOther(name: string): RelayDelivery {
  const other = sessionOn(ORIGIN, 7);
  const changes: Uint8Array[] = [];
  other.onUpdate((update) => changes.push(update));
  rename(other, 'a', name);
  return {
    kind: 'update',
    messageId: new Uint8Array(16).fill(7),
    covers: 0,
    bytes: encodeMessage({ kind: 'update', update: changes[0] ?? new Uint8Array() }),
    compressedBytes: 4,
    settled: 1,
  };
}

/** Builds the relay state of a page around a fake bridge, with its open session. */
function page(session: SharedSession | null = sessionOn(ORIGIN, 1)) {
  const requests: unknown[][] = [];
  const sent: RelayOutgoing[] = [];
  const repairs: unknown[] = [];
  const kept: unknown[] = [];
  const opened: OpenedProject[] = [];
  const told: unknown[][] = [];
  let current = session;
  const answers = {
    share: success(LINKS) as BridgeResult<RelayLinks>,
    join: failure({ code: 'INVALID_LINK' }) as BridgeResult<RelayJoined>,
    reopen: success(null) as BridgeResult<RelayReopened | null>,
    newLinks: success(NEW_LINKS) as BridgeResult<RelayLinks>,
    stop: DONE,
    copy: DONE,
    guide: DONE,
    forget: DONE,
    keep: success({ localCopySaved: true }) as BridgeResult<{ readonly localCopySaved: boolean }>,
    opens: true,
    meanwhile: (): void => undefined,
  };
  const bridge: RelayBridge = {
    shareThroughRelay: (address) => {
      requests.push(['shareThroughRelay', address]);
      answers.meanwhile();
      return Promise.resolve(answers.share);
    },
    joinByLink: (link) => {
      requests.push(['joinByLink', link]);
      answers.meanwhile();
      return Promise.resolve(answers.join);
    },
    reopenSharedPlan: (documentId) => {
      requests.push(['reopenSharedPlan', documentId]);
      answers.meanwhile();
      return Promise.resolve(answers.reopen);
    },
    makeNewLinks: () => {
      requests.push(['makeNewLinks']);
      return Promise.resolve(answers.newLinks);
    },
    stopCollaboration: () => {
      requests.push(['stopCollaboration']);
      return Promise.resolve(answers.stop);
    },
    copyRelayLink: (kind) => {
      requests.push(['copyRelayLink', kind]);
      return Promise.resolve(answers.copy);
    },
    openGuide: () => {
      requests.push(['openGuide']);
      return Promise.resolve(answers.guide);
    },
    forgetSharedPlan: () => {
      requests.push(['forgetSharedPlan']);
      return Promise.resolve(answers.forget);
    },
    sendToRelay: (outgoing) => {
      sent.push(outgoing);
    },
    keepOwnChanges: (_state, planName) => {
      requests.push(['keepOwnChanges', planName]);
      return Promise.resolve(answers.keep);
    },
  };
  const relay: RelayState = new RelayState({
    bridge,
    session: () => current,
    openJoined: (joined) => {
      opened.push(joined);
      const read = openSharedSessionFromState(joined.state);
      if (!answers.opens || !read.ok) {
        return Promise.resolve(false);
      }
      current = read.value;
      relay.attached(read.value);
      return Promise.resolve(true);
    },
    repaired: (found) => repairs.push(...found),
    ownChangesKept: (result) => kept.push(result),
    name: () => 'Léa',
    selectedTaskId: () => null,
    randomBytes: seededRandom(3),
    ended: (reason, relay) => told.push(['ended', reason, relay]),
    linkNotKept: () => told.push(['linkNotKept']),
    changeRefused: () => told.push(['changeRefused']),
    notReopened: (failure) => told.push(['notReopened', failure.code]),
  });
  return {
    relay,
    requests,
    sent,
    repairs,
    kept,
    opened,
    answers,
    told,
    session: () => current,
    close: () => {
      current = null;
    },
    kinds: () =>
      sent.map((outgoing) => (outgoing.kind === 'message' ? outgoing.message.kind : 'presence')),
  };
}

/** Gives what joining by a link answers: the original plan to open, with the right of the link and whether this computer keeps it. */
function joined(canEdit: boolean, kept = true): BridgeResult<RelayJoined> {
  return success({
    project: {
      state: sessionOn(ORIGIN, 2).encodeState(),
      documentId: TEST_DOCUMENT_ID,
      fileName: '',
      warnings: [],
      localChanges: null,
    },
    shown: canEdit ? BOTH_LINKS : VIEW_LINK,
    relay: 'relay.example.org',
    bytesSinceSnapshot: 0,
    kept,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sharing a plan through a relay from the page', () => {
  it('needs an open plan', async () => {
    const { relay, requests } = page(null);
    expect([await relay.share('wss://relay.example.org'), requests]).toEqual([
      failure({ code: 'NO_PROJECT' }),
      [],
    ]);
  });

  it('shares the open plan, holding what comes before the answer, and puts the whole plan on the relay once in', async () => {
    const shared = page();
    const session = shared.session();
    if (session !== null) {
      rename(session, 'a', 'Before sharing');
    }
    shared.answers.meanwhile = () => {
      shared.relay.receive({ kind: 'relayConnected', member: 1, members: [] });
    };
    const answer = await shared.relay.share('wss://relay.example.org');
    shared.relay.receive({ kind: 'relayCaughtUp' });
    shared.relay.receive({ kind: 'reconnecting' });
    shared.relay.receive({ kind: 'relayConnected', member: 1, members: [] });
    shared.relay.receive({ kind: 'relayCaughtUp' });
    expect([
      answer,
      shared.relay.links,
      shared.relay.relay,
      shared.relay.connection,
      shared.relay.canEdit,
      shared.relay.isReadOnly,
      shared.kinds(),
      nameOf(planOf(shared.sent[0]), 'a'),
    ]).toEqual([
      success(LINKS),
      BOTH_LINKS,
      'relay.example.org',
      'connected',
      true,
      false,
      ['update', 'presence', 'update', 'presence'],
      'Before sharing',
    ]);
  });

  it('ends at once when the relay refuses, or when the page left meanwhile', async () => {
    const refused = page();
    refused.answers.share = failure({ code: 'RELAY_ENDED', reason: 'UNREACHABLE' });
    const left = page();
    left.answers.meanwhile = () => {
      void left.relay.stop();
    };
    expect([
      await refused.relay.share('wss://relay.example.org'),
      refused.relay.isActive,
      await left.relay.share('wss://relay.example.org'),
      left.relay.isActive,
    ]).toEqual([
      failure({ code: 'RELAY_ENDED', reason: 'UNREACHABLE' }),
      false,
      failure({ code: 'CANCELLED' }),
      false,
    ]);
  });
});

describe('joining a plan by its link from the page', () => {
  it('opens the plan, catches its member up at once, then hands it what came meanwhile', async () => {
    const joining = page(null);
    joining.answers.join = joined(true);
    joining.answers.meanwhile = () => {
      joining.relay.receive({ kind: 'relayConnected', member: 2, members: [1] });
      joining.relay.receive({ kind: 'relayDelivery', delivery: changeOfOther('From Camille') });
    };
    const answer = await joining.relay.join('tasklace://relay.example.org/#e1.edit');
    expect([
      answer,
      joining.opened.length,
      nameOf(joining.session(), 'a'),
      joining.relay.connection,
      joining.relay.isOpening,
      joining.kinds(),
    ]).toEqual([success(null), 1, 'From Camille', 'connected', false, ['presence']]);
  });

  it('tells the page when this computer cannot keep the link of the plan joined, and only then', async () => {
    const kept = page(null);
    kept.answers.join = joined(false);
    await kept.relay.join('tasklace://relay.example.org/#v1.view');
    const unkept = page(null);
    unkept.answers.join = joined(false, false);
    await unkept.relay.join('tasklace://relay.example.org/#v1.view');
    expect([kept.told, unkept.told]).toEqual([[], [['linkNotKept']]]);
  });

  it('stays in read only with the link that reads', async () => {
    const reader = page(null);
    reader.answers.join = joined(false);
    await reader.relay.join('tasklace://relay.example.org/#v1.view');
    expect([reader.relay.isReadOnly, reader.relay.canEdit, reader.relay.links]).toEqual([
      true,
      false,
      VIEW_LINK,
    ]);
  });

  it('gives back the refusal of the main process, and leaves a plan that cannot open', async () => {
    const refused = page(null);
    const unopened = page(null);
    unopened.answers.join = joined(true);
    unopened.answers.opens = false;
    const left = page(null);
    left.answers.join = joined(true);
    left.answers.meanwhile = () => {
      void left.relay.stop();
    };
    expect([
      await refused.relay.join('nothing'),
      refused.relay.isActive,
      await unopened.relay.join('tasklace://relay.example.org/#e1.edit'),
      unopened.requests.at(-1),
      unopened.relay.isActive,
      await left.relay.join('tasklace://relay.example.org/#e1.edit'),
    ]).toEqual([
      failure({ code: 'INVALID_LINK' }),
      false,
      failure({ code: 'CANCELLED' }),
      ['stopCollaboration'],
      false,
      failure({ code: 'CANCELLED' }),
    ]);
  });
});

describe('reopening a plan shared through a relay from the page', () => {
  it('does nothing for a plan without a kept link, and logs and tells a plan that cannot come back', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const none = page();
    const failed = page();
    failed.answers.reopen = failure({ code: 'LINK_UNREADABLE' });
    const session = sessionOn(ORIGIN, 1);
    expect([
      await none.relay.reopen(session),
      none.relay.isActive,
      none.told,
      await failed.relay.reopen(session),
      failed.relay.isActive,
      failed.told,
      error.mock.calls,
    ]).toEqual([
      false,
      false,
      [],
      false,
      false,
      [['notReopened', 'LINK_UNREADABLE']],
      [['The plan could not come back to its relay:', { code: 'LINK_UNREADABLE' }]],
    ]);
  });

  it('adds what the relay holds, then shares the whole plan only when this computer holds more', async () => {
    const reopened = page();
    reopened.answers.reopen = success({ shown: BOTH_LINKS, relay: 'relay.example.org' });
    const session = reopened.session();
    if (session === null) {
      throw new Error('A plan is open.');
    }
    rename(session, 'b', 'Only here');
    const onRelay = sessionOn(ORIGIN, 8);
    rename(onRelay, 'a', 'On the relay');
    expect(await reopened.relay.reopen(session)).toBe(true);
    reopened.relay.receive({ kind: 'relayConnected', member: 3, members: [] });
    reopened.relay.receive({
      kind: 'relayState',
      state: onRelay.encodeState(),
      bytesSinceSnapshot: 0,
    });
    reopened.relay.receive({ kind: 'relayCaughtUp' });
    const whole = planOf(reopened.sent[0]);
    expect([
      nameOf(session, 'a'),
      reopened.kinds(),
      [nameOf(whole, 'a'), nameOf(whole, 'b')],
    ]).toEqual(['On the relay', ['update', 'presence'], ['On the relay', 'Only here']]);
  });

  it('keeps apart what this computer holds that the relay lacks with the link that reads, telling where', async () => {
    const reader = page();
    reader.answers.reopen = success({ shown: VIEW_LINK, relay: 'relay.example.org' });
    const session = reader.session();
    if (session === null) {
      throw new Error('A plan is open.');
    }
    await reader.relay.reopen(session);
    reader.relay.receive({ kind: 'relayState', state: null, bytesSinceSnapshot: 0 });
    reader.relay.receive({ kind: 'relayCaughtUp' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([reader.requests.at(-1), reader.kept, reader.kinds()]).toEqual([
      ['keepOwnChanges', session.project().name],
      [success({ planName: session.project().name, localCopySaved: true })],
      ['presence'],
    ]);
  });

  it('tells when what this computer holds could not be kept apart', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reader = page();
    reader.answers.reopen = success({ shown: VIEW_LINK, relay: 'relay.example.org' });
    reader.answers.keep = failure({ code: 'WRITE_FAILED' });
    const session = reader.session();
    if (session === null) {
      throw new Error('A plan is open.');
    }
    await reader.relay.reopen(session);
    reader.relay.receive({ kind: 'relayState', state: null, bytesSinceSnapshot: 0 });
    reader.relay.receive({ kind: 'relayCaughtUp' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([reader.kept, error.mock.calls]).toEqual([
      [failure({ code: 'WRITE_FAILED' })],
      [['The changes this computer holds could not be kept apart:', { code: 'WRITE_FAILED' }]],
    ]);
  });

  it('answers false once another plan was asked for meanwhile', async () => {
    const reopened = page();
    reopened.answers.reopen = success({ shown: BOTH_LINKS, relay: 'relay.example.org' });
    reopened.answers.meanwhile = () => {
      void reopened.relay.stop();
    };
    const session = reopened.session();
    expect(session === null ? null : await reopened.relay.reopen(session)).toBe(false);
  });
});

describe('a plan shared through a relay while it lives', () => {
  /** Shares a plan and gets it in. */
  async function sharedPage() {
    const shared = page();
    await shared.relay.share('wss://relay.example.org');
    shared.relay.receive({ kind: 'relayConnected', member: 1, members: [] });
    shared.relay.receive({ kind: 'relayCaughtUp' });
    return shared;
  }

  it('tells a newcomer where this person is, as the relay passes presences only as they are sent', async () => {
    const shared = await sharedPage();
    const before = shared.kinds().length;
    shared.relay.receive({ kind: 'relayJoined', member: 2 });
    const presence = shared.sent.at(-1);
    expect([
      shared.kinds().slice(before),
      presence?.kind === 'presence' && readMessage(presence.bytes),
    ]).toEqual([
      ['presence'],
      { ok: true, value: { kind: 'presence', name: 'Léa', selectedTaskId: null } },
    ]);
  });

  it('follows who is in, who leaves and the connection coming and going', async () => {
    const shared = await sharedPage();
    shared.relay.receive({ kind: 'relayJoined', member: 2 });
    shared.relay.receive({
      kind: 'relayPresence',
      member: 2,
      presence: {
        bytes: encodeMessage({ kind: 'presence', name: 'Camille', selectedTaskId: null }),
        canEdit: false,
      },
    });
    shared.relay.receive({ kind: 'relayJoined', member: 5 });
    shared.relay.receive({
      kind: 'relayPresence',
      member: 5,
      presence: {
        bytes: encodeMessage({ kind: 'presence', name: 'Noah', selectedTaskId: testId('a') }),
        canEdit: true,
      },
    });
    const shown = shared.relay.others;
    shared.relay.receive({ kind: 'relayLeft', member: 5 });
    const withCamille = [...shared.relay.people.values()];
    shared.relay.receive({ kind: 'relayLeft', member: 2 });
    const afterLeaving = shared.relay.people.size;
    shared.relay.receive({ kind: 'offline' });
    expect([shown, withCamille, afterLeaving, shared.relay.connection]).toEqual([
      [
        { id: 'relay-2', name: 'Camille', color: 1, canEdit: false, selectedTaskId: null },
        { id: 'relay-5', name: 'Noah', color: 2, canEdit: true, selectedTaskId: 'a' },
      ],
      [{ name: 'Camille', selectedTaskId: null, canEdit: false }],
      0,
      'offline',
    ]);
  });

  it('merges the changes of the others, telling the repairs and the messages it refuses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const shared = await sharedPage();
    shared.relay.receive({ kind: 'relayDelivery', delivery: changeOfOther('Theirs') });
    shared.relay.receive({
      kind: 'relayDelivery',
      delivery: {
        ...changeOfOther('Broken'),
        messageId: new Uint8Array(16).fill(9),
        bytes: Uint8Array.of(9),
      },
    });
    expect([nameOf(shared.session(), 'a'), warn.mock.calls, shared.told]).toEqual([
      'Theirs',
      [['The plan shared through a relay refused a message: UNSUPPORTED_VERSION.']],
      [['changeRefused']],
    ]);
  });

  it('tells the repairs a change of the others needed, as when two people close a loop of links', async () => {
    const shared = await sharedPage();
    shared.session()?.apply({ type: 'putDependency', dependency: link('a', 'b') });
    const other = sessionOn(ORIGIN, 7);
    const changes: Uint8Array[] = [];
    other.onUpdate((update) => changes.push(update));
    other.apply({ type: 'putDependency', dependency: link('b', 'a') });
    shared.relay.receive({
      kind: 'relayDelivery',
      delivery: {
        kind: 'update',
        messageId: new Uint8Array(16).fill(5),
        covers: 0,
        bytes: encodeMessage({ kind: 'update', update: changes[0] ?? new Uint8Array() }),
        compressedBytes: 4,
        settled: 2,
      },
    });
    expect([shared.repairs.length > 0, shared.session()?.project().dependencies.length]).toEqual([
      true,
      1,
    ]);
  });

  it('forgets for good only a plan whose room the relay no longer finds, once the main process forgot its link', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const closed = await sharedPage();
    closed.relay.receive({ kind: 'relayEnded', reason: 'CLOSED' });
    const refused = await sharedPage();
    refused.relay.receive({ kind: 'relayEnded', reason: 'NO_ROOM' });
    refused.answers.forget = failure({ code: 'TASK_FAILED' });
    const gone = await sharedPage();
    gone.relay.receive({ kind: 'relayEnded', reason: 'NO_ROOM' });
    expect([
      await closed.relay.forgetPlan(),
      await refused.relay.forgetPlan(),
      refused.relay.isActive,
      await gone.relay.forgetPlan(),
      gone.relay.isActive,
      gone.requests.at(-1),
      error.mock.calls,
    ]).toEqual([
      false,
      false,
      true,
      true,
      false,
      ['forgetSharedPlan'],
      [['The shared plan could not be forgotten:', { code: 'TASK_FAILED' }]],
    ]);
  });

  it('keeps the plan open once the relay ended it, sending nothing more', async () => {
    const shared = await sharedPage();
    shared.relay.receive({ kind: 'relayEnded', reason: 'CLOSED' });
    const sentBefore = shared.sent.length;
    const session = shared.session();
    if (session !== null) {
      rename(session, 'b', 'After the end');
    }
    expect([
      shared.relay.connection,
      shared.relay.lastEnd,
      shared.relay.endOfOpenPlan,
      shared.sent.length,
      shared.told,
    ]).toEqual([
      'lost',
      'CLOSED',
      { reason: 'CLOSED', relay: 'relay.example.org' },
      sentBefore,
      [['ended', 'CLOSED', 'relay.example.org']],
    ]);
  });

  it('makes new links, putting the whole plan in the new room once in, only with the link that edits', async () => {
    const shared = await sharedPage();
    const made = await shared.relay.makeNewLinks();
    const connecting = shared.relay.connection;
    shared.relay.receive({ kind: 'relayConnected', member: 1, members: [] });
    shared.relay.receive({ kind: 'relayCaughtUp' });
    const reader = page(null);
    reader.answers.join = joined(false);
    await reader.relay.join('tasklace://relay.example.org/#v1.view');
    expect([
      made,
      connecting,
      shared.relay.links?.edit,
      shared.kinds().filter((kind) => kind === 'update').length,
      await reader.relay.makeNewLinks(),
    ]).toEqual([
      success(NEW_LINKS),
      'connecting',
      NEW_LINKS.shown.edit,
      2,
      failure({ code: 'TASK_FAILED' }),
    ]);
  });

  it('leaves the plan once asked, telling the main process, and logs a leaving it refused', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const idle = page();
    await idle.relay.stop();
    const shared = await sharedPage();
    shared.answers.stop = failure({ code: 'TASK_FAILED' });
    await shared.relay.stop();
    expect([
      idle.requests,
      shared.relay.isActive,
      shared.requests.at(-1),
      error.mock.calls,
    ]).toEqual([
      [],
      false,
      ['stopCollaboration'],
      [['The plan shared through a relay could not be left:', { code: 'TASK_FAILED' }]],
    ]);
  });

  it('forgets the plan without telling the main process when it already stopped', async () => {
    const shared = await sharedPage();
    shared.relay.forget();
    expect([shared.relay.isActive, shared.relay.connection, shared.requests.at(-1)]).toEqual([
      false,
      null,
      ['shareThroughRelay', 'wss://relay.example.org'],
    ]);
  });
});

describe('a page that shares nothing through a relay', () => {
  it('tells nothing of a relay, and ignores a session it did not wait for', () => {
    const idle = page();
    const session = idle.session();
    if (session !== null) {
      idle.relay.attached(session);
    }
    expect([
      idle.relay.isActive,
      idle.relay.isOpening,
      idle.relay.connection,
      idle.relay.relay,
      idle.relay.links,
      idle.relay.canEdit,
      idle.relay.isReadOnly,
      idle.relay.people.size,
      idle.relay.lastEnd,
      idle.relay.endOfOpenPlan,
    ]).toEqual([false, false, null, null, null, false, false, 0, null, null]);
  });

  it('keeps the links it has when new ones cannot be made', async () => {
    const shared = page();
    await shared.relay.share('wss://relay.example.org');
    shared.answers.newLinks = failure({ code: 'NOT_CONNECTED' });
    expect([await shared.relay.makeNewLinks(), shared.relay.links]).toEqual([
      failure({ code: 'NOT_CONNECTED' }),
      BOTH_LINKS,
    ]);
  });

  it('keeps nothing apart once the plan is no longer open', async () => {
    const reader = page();
    reader.answers.reopen = success({ shown: VIEW_LINK, relay: 'relay.example.org' });
    const session = reader.session();
    if (session === null) {
      throw new Error('A plan is open.');
    }
    await reader.relay.reopen(session);
    reader.close();
    reader.relay.receive({ kind: 'relayState', state: null, bytesSinceSnapshot: 0 });
    reader.relay.receive({ kind: 'relayCaughtUp' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([reader.requests.at(-1), reader.kept]).toEqual([
      ['reopenSharedPlan', TEST_DOCUMENT_ID],
      [],
    ]);
  });
});

describe('the events a plan shared through a relay follows', () => {
  it.each([
    [{ kind: 'relayCaughtUp' }, true],
    [{ kind: 'offline' }, true],
    [{ kind: 'reconnecting' }, true],
    [{ kind: 'connected' }, false],
    [{ kind: 'hostLeft' }, false],
  ] as const)('tells whether %o is one', (event, followed) => {
    expect(isRelayEvent(event)).toBe(followed);
  });
});

describe('the links and the guide of a plan shared through a relay', () => {
  it('copies a link and opens the guide through the main process, telling whether it could', async () => {
    const shared = page();
    await shared.relay.share('wss://relay.example.org');
    const copied = await shared.relay.copyLink('edit');
    const guided = await shared.relay.openGuide();
    shared.answers.copy = failure({ code: 'TASK_FAILED' });
    shared.answers.guide = failure({ code: 'TASK_FAILED' });
    expect([
      copied,
      guided,
      await shared.relay.copyLink('view'),
      await shared.relay.openGuide(),
      shared.requests.slice(1),
    ]).toEqual([
      true,
      true,
      false,
      false,
      [['copyRelayLink', 'edit'], ['openGuide'], ['copyRelayLink', 'view'], ['openGuide']],
    ]);
  });

  it('tells whether this computer keeps the link, after sharing, joining, making new links and coming back', async () => {
    const shared = page();
    shared.answers.share = success({ ...LINKS, kept: false });
    await shared.relay.share('wss://relay.example.org');
    const afterSharing = shared.relay.isLinkKept;
    await shared.relay.makeNewLinks();
    const reader = page(null);
    reader.answers.join = joined(false, false);
    await reader.relay.join('tasklace://relay.example.org/#v1.view');
    const reopened = page();
    reopened.answers.reopen = success({ shown: BOTH_LINKS, relay: 'relay.example.org' });
    const session = reopened.session();
    if (session !== null) {
      await reopened.relay.reopen(session);
    }
    expect([
      page().relay.isLinkKept,
      afterSharing,
      shared.relay.isLinkKept,
      reader.relay.isLinkKept,
      reopened.relay.isLinkKept,
    ]).toEqual([false, false, true, false, true]);
  });

  it('tells that it waits for the main process only while a request is unanswered', async () => {
    const shared = page();
    let waiting: boolean | null = null;
    shared.answers.meanwhile = () => {
      waiting = shared.relay.isStarting;
    };
    await shared.relay.share('wss://relay.example.org');
    expect([waiting, shared.relay.isStarting, page().relay.isStarting]).toEqual([
      true,
      false,
      false,
    ]);
  });
});
