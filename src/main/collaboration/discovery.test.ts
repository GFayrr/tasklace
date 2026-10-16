import type { Bonjour } from 'bonjour-service';
import { describe, expect, it, vi } from 'vitest';
import {
  announcePlan,
  ANNOUNCE_VERSION,
  findPlans,
  mdnsOf,
  MAX_TXT_VALUE_BYTES,
  readNearbyPlan,
  SERVICE_TYPE,
  type AnnouncedService,
  type Mdns,
  type NearbyPlan,
} from './discovery';

const SHARING = 'a'.repeat(32);
const TXT = { v: '1', plan: 'Thesis', host: 'Camille', share: SHARING, rank: '0' };

const SERVICE: AnnouncedService = {
  name: 'Tasklace 1a2b',
  fqdn: 'Tasklace 1a2b._tasklace._tcp.local',
  port: 47_313,
  addresses: ['192.168.1.20', '8.8.8.8', 'fe80::1'],
  txt: { v: ANNOUNCE_VERSION, plan: 'Thesis', host: 'Camille', share: SHARING, rank: '0' },
};

/** Builds a fake mDNS that records what is published and lets the test announce services. */
function fakeMdns() {
  const listeners = new Map<string, (service: AnnouncedService) => void>();
  const published: unknown[] = [];
  const stopped: string[] = [];
  const mdns: Mdns = {
    publish: (options) => {
      published.push(options);
      return {
        stop: (done) => {
          stopped.push('service');
          done?.();
        },
      };
    },
    find: (options) => {
      published.push(options);
      return {
        on: (event, listener) => listeners.set(event, listener),
        stop: () => stopped.push('browser'),
      };
    },
  };
  return {
    mdns,
    published,
    stopped,
    up: (service: AnnouncedService) => listeners.get('up')?.(service),
    down: (service: AnnouncedService) => listeners.get('down')?.(service),
  };
}

describe('announcing a shared plan', () => {
  it('publishes and searches through bonjour-service, stopping its service with the callback', () => {
    const stop = vi.fn((done?: () => void) => done?.());
    const browser = { on: vi.fn(), stop: vi.fn() };
    const bonjour = { publish: vi.fn(() => ({ stop })), find: vi.fn(() => browser) };
    const mdns = mdnsOf(bonjour as unknown as Pick<Bonjour, 'publish' | 'find'>);
    const done = vi.fn();
    mdns.publish({ name: 'n', type: SERVICE_TYPE, port: 1, txt: { v: '1' } }).stop(done);
    expect([bonjour.publish.mock.calls, stop.mock.calls.length, done.mock.calls.length]).toEqual([
      [[{ name: 'n', type: SERVICE_TYPE, port: 1, txt: { v: '1' } }]],
      1,
      1,
    ]);
    expect(mdns.find({ type: SERVICE_TYPE })).toBe(browser);
  });

  it('publishes the names, the sharing, the rank and the port, never the code nor the key, and stops when asked', async () => {
    const fake = fakeMdns();
    const stop = announcePlan(fake.mdns, {
      instance: '1a2b',
      port: 47_313,
      planName: 'Thesis',
      hostName: 'Camille',
      sharingId: SHARING,
      rank: 3,
    });
    expect(fake.published).toEqual([
      {
        name: 'Tasklace 1a2b',
        type: SERVICE_TYPE,
        port: 47_313,
        txt: { ...TXT, rank: '3' },
      },
    ]);
    await stop();
    expect(fake.stopped).toEqual(['service']);
  });

  it('shortens a long name by whole characters to fit an announcement', () => {
    const fake = fakeMdns();
    announcePlan(fake.mdns, {
      instance: 'x',
      port: 1,
      planName: 'é'.repeat(150),
      hostName: 'A',
      sharingId: SHARING,
      rank: 0,
    });
    const txt = (fake.published[0] as { txt: { plan: string } }).txt;
    expect(txt.plan).toBe('é'.repeat(MAX_TXT_VALUE_BYTES / 2));
  });
});

describe('finding shared plans nearby', () => {
  it('lists the plans as they appear and go, by name, with their private addresses only', () => {
    const fake = fakeMdns();
    const lists: (readonly NearbyPlan[])[] = [];
    const stop = findPlans(fake.mdns, (plans) => lists.push(plans));
    const other = { ...SERVICE, fqdn: 'other', txt: { ...TXT, plan: 'Budget', host: 'Noah' } };
    fake.up(SERVICE);
    fake.up(other);
    fake.up({ ...SERVICE, fqdn: 'bad', port: 0 });
    fake.down({ ...SERVICE, fqdn: 'unknown' });
    fake.down(SERVICE);
    stop();
    const thesis = {
      key: SERVICE.fqdn,
      instance: SERVICE.name,
      planName: 'Thesis',
      hostName: 'Camille',
      sharingId: SHARING,
      rank: 0,
      addresses: ['192.168.1.20', 'fe80::1'],
      port: 47_313,
    };
    const budget = { ...thesis, key: 'other', planName: 'Budget', hostName: 'Noah' };
    expect(lists).toEqual([[thesis], [budget, thesis], [budget]]);
    expect(fake.stopped).toEqual(['browser']);
  });

  it('orders plans of the same name by host', () => {
    const fake = fakeMdns();
    const lists: (readonly NearbyPlan[])[] = [];
    findPlans(fake.mdns, (plans) => lists.push(plans));
    fake.up(SERVICE);
    fake.up({ ...SERVICE, fqdn: 'b', txt: { ...TXT, host: 'Ana' } });
    expect(lists.at(-1)?.map((plan) => plan.hostName)).toEqual(['Ana', 'Camille']);
  });

  it.each([
    ['no text record', { ...SERVICE, txt: undefined }],
    ['another version', { ...SERVICE, txt: { ...TXT, v: '2' } }],
    ['no plan name', { ...SERVICE, txt: { ...TXT, plan: undefined } }],
    ['no sharing', { ...SERVICE, txt: { ...TXT, share: undefined } }],
    ['a sharing of another form', { ...SERVICE, txt: { ...TXT, share: 'A'.repeat(32) } }],
    ['no rank', { ...SERVICE, txt: { ...TXT, rank: undefined } }],
    ['a rank that is no number', { ...SERVICE, txt: { ...TXT, rank: '01' } }],
    ['a rank too high', { ...SERVICE, txt: { ...TXT, rank: '9999999999' } }],
    ['a host name with a control character', { ...SERVICE, txt: { ...TXT, host: 'Ca\nmille' } }],
    ['no private address', { ...SERVICE, addresses: ['8.8.8.8'] }],
    ['no addresses', { ...SERVICE, addresses: undefined }],
    ['an address that is not text', { ...SERVICE, addresses: [7] as unknown as string[] }],
    ['a port out of range', { ...SERVICE, port: 70_000 }],
  ])('ignores an announcement with %s', (_label, service) => {
    expect(readNearbyPlan(service)).toBeNull();
  });

  it('calls nothing when nothing valid appears', () => {
    const fake = fakeMdns();
    const changed = vi.fn();
    findPlans(fake.mdns, changed);
    fake.up({ ...SERVICE, txt: null });
    expect(changed).not.toHaveBeenCalled();
  });
});
