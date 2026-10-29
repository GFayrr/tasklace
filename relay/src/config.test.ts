import { describe, expect, it } from 'vitest';
import { readConfig } from './config.ts';

describe('the settings of the relay', () => {
  it('falls back to safe defaults when nothing is set', () => {
    expect(readConfig({})).toEqual({
      ok: true,
      config: {
        host: '127.0.0.1',
        port: 8080,
        dataDirectory: 'data',
        maxRooms: 4_096,
        maxRoomBytes: 268_435_456,
        maxStoredBytes: 1_073_741_824,
        maxConnections: 1_024,
        maxConnectionsPerAddress: 32,
        connectionsPerMinutePerAddress: 64,
        roomExpiryDays: 90,
        trustProxy: false,
        tls: null,
      },
    });
  });

  it('reads every setting of its environment, spaces around them aside', () => {
    const read = readConfig({
      RELAY_HOST: ' 0.0.0.0 ',
      RELAY_PORT: '443',
      RELAY_DATA_DIR: '/var/lib/relay',
      RELAY_MAX_ROOMS: '10',
      RELAY_MAX_ROOM_BYTES: '1048576',
      RELAY_MAX_STORED_BYTES: '2097152',
      RELAY_MAX_CONNECTIONS: '5',
      RELAY_MAX_CONNECTIONS_PER_ADDRESS: '2',
      RELAY_CONNECTIONS_PER_MINUTE_PER_ADDRESS: '3',
      RELAY_ROOM_EXPIRY_DAYS: '7',
      RELAY_TRUST_PROXY: 'Yes',
      RELAY_TLS_CERT: 'cert.pem',
      RELAY_TLS_KEY: 'key.pem',
    });
    expect(read).toEqual({
      ok: true,
      config: {
        host: '0.0.0.0',
        port: 443,
        dataDirectory: '/var/lib/relay',
        maxRooms: 10,
        maxRoomBytes: 1_048_576,
        maxStoredBytes: 2_097_152,
        maxConnections: 5,
        maxConnectionsPerAddress: 2,
        connectionsPerMinutePerAddress: 3,
        roomExpiryDays: 7,
        trustProxy: true,
        tls: { certificateFile: 'cert.pem', keyFile: 'key.pem' },
      },
    });
  });

  it('turns trusting a proxy off by its words', () => {
    const read = ['0', 'false', 'no', ''].map((word) => {
      const result = readConfig({ RELAY_TRUST_PROXY: word });
      return result.ok ? result.config.trustProxy : result.problem;
    });
    expect(read).toEqual([false, false, false, false]);
  });

  it('tells the first setting that is wrong', () => {
    const problems = [
      { RELAY_PORT: '65536' },
      { RELAY_PORT: '-1' },
      { RELAY_PORT: '80.5' },
      { RELAY_PORT: '1e3' },
      { RELAY_MAX_ROOMS: '0' },
      { RELAY_MAX_ROOMS: '99999999999999999' },
      { RELAY_MAX_ROOM_BYTES: '1048575' },
      { RELAY_MAX_ROOM_BYTES: '4194304', RELAY_MAX_STORED_BYTES: '2097152' },
      { RELAY_ROOM_EXPIRY_DAYS: '36501' },
      { RELAY_TRUST_PROXY: 'maybe' },
      { RELAY_TLS_CERT: 'cert.pem' },
      { RELAY_TLS_KEY: 'key.pem' },
    ].map((environment) => {
      const result = readConfig(environment);
      return result.ok ? result : result.problem;
    });
    expect(problems).toEqual([
      'RELAY_PORT must be a whole number from 0 to 65535.',
      'RELAY_PORT must be a whole number from 0 to 65535.',
      'RELAY_PORT must be a whole number from 0 to 65535.',
      'RELAY_PORT must be a whole number from 0 to 65535.',
      'RELAY_MAX_ROOMS must be a whole number from 1 to 1048576.',
      'RELAY_MAX_ROOMS must be a whole number from 1 to 1048576.',
      'RELAY_MAX_ROOM_BYTES must be a whole number from 1048576 to 9007199254740991.',
      'RELAY_MAX_ROOM_BYTES must not be above RELAY_MAX_STORED_BYTES.',
      'RELAY_ROOM_EXPIRY_DAYS must be a whole number from 1 to 36500.',
      'RELAY_TRUST_PROXY must be 1, true or yes to turn it on, or 0, false or no to turn it off.',
      'RELAY_TLS_CERT and RELAY_TLS_KEY must be set together.',
      'RELAY_TLS_CERT and RELAY_TLS_KEY must be set together.',
    ]);
  });
});
