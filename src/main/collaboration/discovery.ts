import type { Bonjour } from 'bonjour-service';
import { MAX_PARTICIPANT_NAME_LENGTH, MAX_PROJECT_NAME_LENGTH } from '../../core/limits';
import { createIssueList } from '../../core/validation/validation-issues';
import { readText } from '../../core/validation/value-readers';
import { isPort } from '../../core/collaboration/ports';
import { SHARING_ID_BYTES } from '../../core/collaboration/succession';
import { MAX_JOIN_RANK } from '../../core/limits';
import { isPrivateAddress } from './private-addresses';

export interface AnnouncedService {
  readonly name: string;
  readonly port: number;
  readonly addresses?: readonly string[] | undefined;
  readonly txt?: unknown;
  readonly fqdn: string;
}

export interface ServiceBrowser {
  readonly on: (event: 'up' | 'down', listener: (service: AnnouncedService) => void) => unknown;
  readonly stop: () => void;
}

export interface Mdns {
  readonly publish: (options: {
    readonly name: string;
    readonly type: string;
    readonly port: number;
    readonly txt: Readonly<Record<string, string>>;
  }) => { readonly stop: (done?: (error?: unknown) => void) => void };
  readonly find: (options: { readonly type: string }) => ServiceBrowser;
}

export interface NearbyPlan {
  readonly key: string;
  readonly instance: string;
  readonly planName: string;
  readonly hostName: string;
  readonly sharingId: string;
  readonly rank: number;
  readonly addresses: readonly string[];
  readonly port: number;
}

export const SERVICE_TYPE = 'tasklace';
export const ANNOUNCE_VERSION = '1';
export const MAX_TXT_VALUE_BYTES = 200;

const SERVICE_NAME_PREFIX = 'Tasklace';
const ENCODER = new TextEncoder();
const SHARING_ID_PATTERN = new RegExp(`^[0-9a-f]{${String(SHARING_ID_BYTES * 2)}}$`);
const RANK_PATTERN = /^(0|[1-9][0-9]{0,9})$/;

/** Gives bonjour-service the shape the announcement and the search use, its services typing their stop as any function. */
export function mdnsOf(bonjour: Pick<Bonjour, 'publish' | 'find'>): Mdns {
  return {
    publish: (options) => {
      const service = bonjour.publish({ ...options, txt: { ...options.txt } });
      return {
        stop: (done) => {
          Reflect.apply(service.stop, service, [done]);
        },
      };
    },
    find: (options) => bonjour.find(options),
  };
}

/** Gives the name a host announces its plan under on the network. */
export function serviceNameOf(instance: string): string {
  return `${SERVICE_NAME_PREFIX} ${instance}`;
}

/** Announces a shared plan on the private networks with its name, the name of its host, the identifier of the sharing, the rank of its host and its port, never its code nor its key. */
export function announcePlan(
  mdns: Mdns,
  plan: {
    readonly instance: string;
    readonly port: number;
    readonly planName: string;
    readonly hostName: string;
    readonly sharingId: string;
    readonly rank: number;
  },
): () => Promise<void> {
  const service = mdns.publish({
    name: serviceNameOf(plan.instance),
    type: SERVICE_TYPE,
    port: plan.port,
    txt: {
      v: ANNOUNCE_VERSION,
      plan: fitBytes(plan.planName),
      host: fitBytes(plan.hostName),
      share: plan.sharingId,
      rank: String(plan.rank),
    },
  });
  return () =>
    new Promise((resolve) => {
      service.stop((error) => {
        if (error !== undefined && error !== null) {
          console.warn('The shared plan could not tell the network it is no longer shared:', error);
        }
        resolve();
      });
    });
}

/** Follows the shared plans announced nearby, giving the whole list each time a plan appears or goes, and ignoring any announcement that is not a valid plan on a private network. */
export function findPlans(mdns: Mdns, changed: (plans: readonly NearbyPlan[]) => void): () => void {
  const plans = new Map<string, NearbyPlan>();
  const browser = mdns.find({ type: SERVICE_TYPE });
  /** Tells the list as it now is, ordered by plan then host so that it does not jump around. */
  const tell = (): void => {
    changed(
      [...plans.values()].sort(
        (first, second) =>
          first.planName.localeCompare(second.planName) ||
          first.hostName.localeCompare(second.hostName),
      ),
    );
  };
  browser.on('up', (service) => {
    const plan = readNearbyPlan(service);
    if (plan !== null) {
      plans.set(plan.key, plan);
      tell();
    }
  });
  browser.on('down', (service) => {
    if (plans.delete(service.fqdn)) {
      tell();
    }
  });
  return () => {
    browser.stop();
  };
}

/** Reads an announcement heard on the network, which anyone nearby can send, keeping only its private addresses and refusing it without a valid port, version, names, sharing, rank or address. */
export function readNearbyPlan(service: AnnouncedService): NearbyPlan | null {
  const txt: unknown = service.txt;
  if (typeof txt !== 'object' || txt === null || Reflect.get(txt, 'v') !== ANNOUNCE_VERSION) {
    return null;
  }
  const issues = createIssueList();
  const planName = readText(
    { value: Reflect.get(txt, 'plan'), path: 'plan' },
    issues,
    MAX_PROJECT_NAME_LENGTH,
  );
  const hostName = readText(
    { value: Reflect.get(txt, 'host'), path: 'host' },
    issues,
    MAX_PARTICIPANT_NAME_LENGTH,
  );
  const sharingId: unknown = Reflect.get(txt, 'share');
  const rank: unknown = Reflect.get(txt, 'rank');
  const addresses = (Array.isArray(service.addresses) ? service.addresses : []).filter(
    (address): address is string => typeof address === 'string' && isPrivateAddress(address),
  );
  if (
    planName === undefined ||
    hostName === undefined ||
    typeof sharingId !== 'string' ||
    !SHARING_ID_PATTERN.test(sharingId) ||
    typeof rank !== 'string' ||
    !RANK_PATTERN.test(rank) ||
    Number(rank) > MAX_JOIN_RANK ||
    addresses.length === 0 ||
    !isPort(service.port)
  ) {
    return null;
  }
  return {
    key: service.fqdn,
    instance: service.name,
    planName,
    hostName,
    sharingId,
    rank: Number(rank),
    addresses,
    port: service.port,
  };
}

/** Shortens a name, by whole characters, to what a value of an announcement can hold. */
function fitBytes(text: string): string {
  let fitted = '';
  let bytes = 0;
  for (const character of text) {
    bytes += ENCODER.encode(character).length;
    if (bytes > MAX_TXT_VALUE_BYTES) {
      return fitted;
    }
    fitted += character;
  }
  return fitted;
}
