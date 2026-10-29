export interface Rate {
  readonly perSecond: number;
  readonly burst: number;
}

export type Bucket = () => boolean;

const MILLISECONDS_PER_SECOND = 1_000;

/** Makes a bucket of tokens that refills at a steady rate up to its burst, each call spending one token and telling whether there was one. */
export function createBucket(rate: Rate, now: () => number): Bucket {
  let tokens = rate.burst;
  let at = now();
  return () => {
    const time = now();
    const gained = (Math.max(0, time - at) * rate.perSecond) / MILLISECONDS_PER_SECOND;
    tokens = Math.min(rate.burst, tokens + gained);
    at = time;
    if (tokens < 1) {
      return false;
    }
    tokens -= 1;
    return true;
  };
}

/** Keeps a bucket for each of a bounded number of addresses, forgetting the one seen least recently once too many are kept. */
export function createAddressBuckets(
  rate: Rate,
  maxAddresses: number,
  now: () => number,
): (address: string) => boolean {
  const buckets = new Map<string, Bucket>();
  return (address) => {
    const bucket = buckets.get(address) ?? createBucket(rate, now);
    buckets.delete(address);
    buckets.set(address, bucket);
    const oldest = buckets.keys().next();
    if (buckets.size > maxAddresses && !oldest.done) {
      buckets.delete(oldest.value);
    }
    return bucket();
  };
}
