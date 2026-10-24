import { GUEST_ENDS, type CollaborationEvent, type NearbyPlan } from './bridge-contract';
import { readEndpoint } from '../core/collaboration/endpoint';
import { isParticipantId } from '../core/collaboration/participants';
import { isJoinCode } from '../core/collaboration/secure/join-code';
import { isTokenDigest } from '../core/collaboration/secure/token-digest';
import { createIssueList } from '../core/validation/validation-issues';

const GUEST_END_VALUES: readonly unknown[] = GUEST_ENDS;

/** Reads a field of a value of any shape. */
function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

/** Tells whether a value is a whole number. */
function isWhole(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Tells whether a value has the shape of a plan announced nearby. */
function isNearbyPlan(value: unknown): value is NearbyPlan {
  const addresses = field(value, 'addresses');
  return (
    typeof field(value, 'key') === 'string' &&
    typeof field(value, 'planName') === 'string' &&
    typeof field(value, 'hostName') === 'string' &&
    Array.isArray(addresses) &&
    addresses.every((address) => typeof address === 'string') &&
    isWhole(field(value, 'port'))
  );
}

/** Tells whether a value says where a participant could host the plan, as the core reads it. */
function isEndpoint(value: unknown): boolean {
  return readEndpoint({ value, path: '' }, createIssueList()) !== undefined;
}

/** Tells whether a value describes a plan this window now hosts: its code, port and addresses. */
function isSharing(value: unknown): boolean {
  const addresses = field(value, 'addresses');
  return (
    isJoinCode(field(value, 'code')) &&
    isTokenDigest(field(value, 'tokenDigest')) &&
    isWhole(field(value, 'port')) &&
    Array.isArray(addresses) &&
    addresses.every((address) => typeof address === 'string')
  );
}

const EVENT_CHECKS: Readonly<Record<CollaborationEvent['kind'], (value: unknown) => boolean>> = {
  peerJoined: (value) =>
    isWhole(field(value, 'peer')) &&
    isParticipantId(field(value, 'participantId')) &&
    typeof field(value, 'name') === 'string' &&
    isEndpoint(field(value, 'endpoint')) &&
    isTokenDigest(field(value, 'tokenDigest')),
  peerMessage: (value) =>
    isWhole(field(value, 'peer')) && field(value, 'message') instanceof Uint8Array,
  peerLeft: (value) => isWhole(field(value, 'peer')),
  codeChanged: (value) => isJoinCode(field(value, 'code')),
  nearbyPlans: (value) => {
    const plans = field(value, 'plans');
    return Array.isArray(plans) && plans.every(isNearbyPlan);
  },
  connected: () => true,
  reconnecting: () => true,
  hostLeft: () => true,
  yielded: () => true,
  becameHost: (value) => isSharing(field(value, 'sharing')),
  offline: () => true,
  hostMessage: (value) => field(value, 'message') instanceof Uint8Array,
  ended: (value) => GUEST_END_VALUES.includes(field(value, 'reason')),
};

/** Tells whether a value names a kind of event, by the table that checks each kind. */
function isEventKind(kind: unknown): kind is CollaborationEvent['kind'] {
  return typeof kind === 'string' && Object.hasOwn(EVENT_CHECKS, kind);
}

/** Tells whether what the main process sent about the shared plan has the shape of one of its events. */
export function isCollaborationEvent(value: unknown): value is CollaborationEvent {
  const kind = field(value, 'kind');
  return isEventKind(kind) && EVENT_CHECKS[kind](value);
}
