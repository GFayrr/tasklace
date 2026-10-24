import {
  ADDRESS_HANDSHAKE_BURST,
  ADDRESS_HANDSHAKES_PER_SECOND,
  FIRST_WRONG_CODE_WAIT_MILLISECONDS,
  HANDSHAKE_BURST,
  HANDSHAKES_PER_SECOND,
  MAX_THROTTLED_ADDRESSES,
  MAX_WRONG_CODE_WAIT_MILLISECONDS,
} from '../limits';

export interface Admission {
  readonly admit: (address: string) => boolean;
  readonly wrongCode: (address: string) => void;
  readonly joined: (address: string) => void;
}

interface Bucket {
  tokens: number;
  at: number;
}

interface AddressState {
  readonly bucket: Bucket;
  wrongCodes: number;
  waitUntil: number;
}

const MILLISECONDS_PER_SECOND = 1_000;
const GROWTH = 2;
const FREE_WRONG_CODES = 1;

/** Limits how fast a host lets connections start the costly exchange of keys, everywhere and from each address, and makes an address wait longer after each wrong code, remembering a bounded number of addresses. */
export function createAdmission(now: () => number): Admission {
  const everyone: Bucket = { tokens: HANDSHAKE_BURST, at: now() };
  const addresses = new Map<string, AddressState>();
  /** Gives the state of an address, as the most recently seen, forgetting the oldest address once too many are kept. */
  const stateOf = (address: string): AddressState => {
    const known = addresses.get(address);
    addresses.delete(address);
    const state = known ?? {
      bucket: { tokens: ADDRESS_HANDSHAKE_BURST, at: now() },
      wrongCodes: 0,
      waitUntil: 0,
    };
    addresses.set(address, state);
    const oldest = addresses.keys().next();
    if (addresses.size > MAX_THROTTLED_ADDRESSES && !oldest.done) {
      addresses.delete(oldest.value);
    }
    return state;
  };
  return {
    admit: (address) => {
      const state = stateOf(address);
      const time = now();
      if (time < state.waitUntil || !hasToken(state.bucket, time, ADDRESS_LIMIT)) {
        return false;
      }
      if (!hasToken(everyone, time, GLOBAL_LIMIT)) {
        return false;
      }
      takeToken(state.bucket);
      takeToken(everyone);
      return true;
    },
    wrongCode: (address) => {
      const state = stateOf(address);
      state.wrongCodes += 1;
      state.waitUntil = now() + wrongCodeWait(state.wrongCodes);
    },
    joined: (address) => {
      const state = stateOf(address);
      state.wrongCodes = 0;
      state.waitUntil = 0;
    },
  };
}

interface Rate {
  readonly perSecond: number;
  readonly burst: number;
}

const GLOBAL_LIMIT: Rate = { perSecond: HANDSHAKES_PER_SECOND, burst: HANDSHAKE_BURST };
const ADDRESS_LIMIT: Rate = {
  perSecond: ADDRESS_HANDSHAKES_PER_SECOND,
  burst: ADDRESS_HANDSHAKE_BURST,
};

/** Refills a bucket for the time gone by, up to its burst, and tells whether it holds a whole token. */
function hasToken(bucket: Bucket, time: number, rate: Rate): boolean {
  const gained = (Math.max(0, time - bucket.at) * rate.perSecond) / MILLISECONDS_PER_SECOND;
  bucket.tokens = Math.min(rate.burst, bucket.tokens + gained);
  bucket.at = time;
  return bucket.tokens >= 1;
}

/** Spends one token of a bucket. */
function takeToken(bucket: Bucket): void {
  bucket.tokens -= 1;
}

/** Gives how long an address waits after a number of wrong codes in a row: nothing after the first, so that a person who mistyped tries again at once, then about a second doubling up to a limit. */
export function wrongCodeWait(wrongCodes: number): number {
  if (wrongCodes < FREE_WRONG_CODES + 1) {
    return 0;
  }
  const doubled =
    FIRST_WRONG_CODE_WAIT_MILLISECONDS * GROWTH ** (wrongCodes - FREE_WRONG_CODES - 1);
  return Math.min(doubled, MAX_WRONG_CODE_WAIT_MILLISECONDS);
}
