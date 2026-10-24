import { BlockList, isIPv4, isIPv6 } from 'node:net';

const PRIVATE_IPV4_RANGES: readonly (readonly [string, number])[] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  ['127.0.0.0', 8],
];
const PRIVATE_IPV6_RANGES: readonly (readonly [string, number])[] = [
  ['fc00::', 7],
  ['fe80::', 10],
  ['::1', 128],
];
const MAPPED_IPV4_PREFIX = '::ffff:';
const ZONE_SEPARATOR = '%';

const PRIVATE_ADDRESSES = privateAddressList();

/** Lists the ranges of a private network, local link and loopback addresses included, where a shared plan may be reached. */
function privateAddressList(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of PRIVATE_IPV4_RANGES) {
    list.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of PRIVATE_IPV6_RANGES) {
    list.addSubnet(network, prefix, 'ipv6');
  }
  return list;
}

/** Tells whether an address is on a private network, reading an IPv4 address written as IPv6 as the IPv4 one and ignoring the zone of a local link, and refusing anything that is not an address. */
export function isPrivateAddress(address: string): boolean {
  const lowered = address.toLowerCase();
  const unmapped = lowered.startsWith(MAPPED_IPV4_PREFIX)
    ? lowered.slice(MAPPED_IPV4_PREFIX.length)
    : lowered;
  const [withoutZone = ''] = unmapped.split(ZONE_SEPARATOR);
  if (isIPv4(withoutZone)) {
    return PRIVATE_ADDRESSES.check(withoutZone, 'ipv4');
  }
  return isIPv6(withoutZone) && PRIVATE_ADDRESSES.check(withoutZone, 'ipv6');
}
