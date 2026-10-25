export interface RelayConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDirectory: string;
  readonly maxRooms: number;
  readonly maxRoomBytes: number;
  readonly maxStoredBytes: number;
  readonly maxConnections: number;
  readonly maxConnectionsPerAddress: number;
  readonly connectionsPerMinutePerAddress: number;
  readonly roomExpiryDays: number;
  readonly trustProxy: boolean;
  readonly tls: { readonly certificateFile: string; readonly keyFile: string } | null;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: RelayConfig }
  | { readonly ok: false; readonly problem: string };

type Environment = Readonly<Record<string, string | undefined>>;

interface Setting {
  readonly name: string;
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
}

const MEBIBYTE = 1_048_576;
const MAX_PORT = 65_535;
const DEFAULT_PORT = 8080;
const DEFAULT_MAX_ROOMS = 4_096;
const DEFAULT_MAX_ROOM_BYTES = 268_435_456;
const DEFAULT_MAX_STORED_BYTES = 1_073_741_824;
const DEFAULT_MAX_CONNECTIONS = 1_024;
const DEFAULT_MAX_CONNECTIONS_PER_ADDRESS = 32;
const DEFAULT_CONNECTIONS_PER_MINUTE = 64;
const DEFAULT_ROOM_EXPIRY_DAYS = 90;
const MAX_ROOM_EXPIRY_DAYS = 36_500;
const LARGEST_COUNT = 1_048_576;
const LARGEST_BYTES = Number.MAX_SAFE_INTEGER;
const TRUE_WORDS = ['1', 'true', 'yes'];
const FALSE_WORDS = ['', '0', 'false', 'no'];

const PORT: Setting = { name: 'RELAY_PORT', fallback: DEFAULT_PORT, min: 0, max: MAX_PORT };
const MAX_ROOMS: Setting = {
  name: 'RELAY_MAX_ROOMS',
  fallback: DEFAULT_MAX_ROOMS,
  min: 1,
  max: LARGEST_COUNT,
};
const MAX_ROOM_BYTES: Setting = {
  name: 'RELAY_MAX_ROOM_BYTES',
  fallback: DEFAULT_MAX_ROOM_BYTES,
  min: MEBIBYTE,
  max: LARGEST_BYTES,
};
const MAX_STORED_BYTES: Setting = {
  name: 'RELAY_MAX_STORED_BYTES',
  fallback: DEFAULT_MAX_STORED_BYTES,
  min: MEBIBYTE,
  max: LARGEST_BYTES,
};
const MAX_CONNECTIONS: Setting = {
  name: 'RELAY_MAX_CONNECTIONS',
  fallback: DEFAULT_MAX_CONNECTIONS,
  min: 1,
  max: LARGEST_COUNT,
};
const MAX_CONNECTIONS_PER_ADDRESS: Setting = {
  name: 'RELAY_MAX_CONNECTIONS_PER_ADDRESS',
  fallback: DEFAULT_MAX_CONNECTIONS_PER_ADDRESS,
  min: 1,
  max: LARGEST_COUNT,
};
const CONNECTIONS_PER_MINUTE: Setting = {
  name: 'RELAY_CONNECTIONS_PER_MINUTE_PER_ADDRESS',
  fallback: DEFAULT_CONNECTIONS_PER_MINUTE,
  min: 1,
  max: LARGEST_COUNT,
};
const ROOM_EXPIRY_DAYS: Setting = {
  name: 'RELAY_ROOM_EXPIRY_DAYS',
  fallback: DEFAULT_ROOM_EXPIRY_DAYS,
  min: 1,
  max: MAX_ROOM_EXPIRY_DAYS,
};

/** Reads the settings of the relay from its environment, each one checked, telling the first one that is wrong. */
export function readConfig(environment: Environment): ConfigResult {
  try {
    return { ok: true, config: configOf(environment) };
  } catch (error) {
    if (error instanceof WrongSetting) {
      return { ok: false, problem: error.message };
    }
    throw error;
  }
}

class WrongSetting extends Error {}

/** Reads every setting, throwing a wrong setting at the first one that does not hold. */
function configOf(environment: Environment): RelayConfig {
  const certificateFile = environment['RELAY_TLS_CERT'] ?? '';
  const keyFile = environment['RELAY_TLS_KEY'] ?? '';
  if ((certificateFile === '') !== (keyFile === '')) {
    throw new WrongSetting('RELAY_TLS_CERT and RELAY_TLS_KEY must be set together.');
  }
  const maxRoomBytes = numberOf(environment, MAX_ROOM_BYTES);
  const maxStoredBytes = numberOf(environment, MAX_STORED_BYTES);
  if (maxRoomBytes > maxStoredBytes) {
    throw new WrongSetting('RELAY_MAX_ROOM_BYTES must not be above RELAY_MAX_STORED_BYTES.');
  }
  return {
    host: textOf(environment, 'RELAY_HOST', '127.0.0.1'),
    port: numberOf(environment, PORT),
    dataDirectory: textOf(environment, 'RELAY_DATA_DIR', 'data'),
    maxRooms: numberOf(environment, MAX_ROOMS),
    maxRoomBytes,
    maxStoredBytes,
    maxConnections: numberOf(environment, MAX_CONNECTIONS),
    maxConnectionsPerAddress: numberOf(environment, MAX_CONNECTIONS_PER_ADDRESS),
    connectionsPerMinutePerAddress: numberOf(environment, CONNECTIONS_PER_MINUTE),
    roomExpiryDays: numberOf(environment, ROOM_EXPIRY_DAYS),
    trustProxy: switchOf(environment, 'RELAY_TRUST_PROXY'),
    tls: certificateFile === '' ? null : { certificateFile, keyFile },
  };
}

/** Reads a whole number setting within its bounds, or its default when it is not set. */
function numberOf(environment: Environment, setting: Setting): number {
  const text = environment[setting.name]?.trim() ?? '';
  if (text === '') {
    return setting.fallback;
  }
  const value = /^\d{1,16}$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < setting.min || value > setting.max) {
    throw new WrongSetting(
      `${setting.name} must be a whole number from ${String(setting.min)} to ${String(setting.max)}.`,
    );
  }
  return value;
}

/** Reads a text setting, or its default when it is not set. */
function textOf(environment: Environment, name: string, fallback: string): string {
  const text = environment[name]?.trim() ?? '';
  return text === '' ? fallback : text;
}

/** Reads a setting that is on or off, off when it is not set. */
function switchOf(environment: Environment, name: string): boolean {
  const text = environment[name]?.trim().toLowerCase() ?? '';
  if (TRUE_WORDS.includes(text)) {
    return true;
  }
  if (FALSE_WORDS.includes(text)) {
    return false;
  }
  throw new WrongSetting(`${name} must be 1 or 0.`);
}
