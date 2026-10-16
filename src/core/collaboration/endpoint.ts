import { MAX_ENDPOINT_ADDRESS_LENGTH, MAX_ENDPOINT_ADDRESSES } from '../limits';
import type { IssueList } from '../validation/validation-issues';
import {
  childField,
  itemField,
  readArray,
  readInteger,
  readRecord,
  type Field,
} from '../validation/value-readers';
import type { Endpoint } from './participants';
import { FIRST_PORT, LAST_PORT } from './ports';

const ENDPOINT_KEYS = ['addresses', 'port'];
const ADDRESS_PATTERN = new RegExp(`^[0-9A-Za-z.:%_-]{1,${String(MAX_ENDPOINT_ADDRESS_LENGTH)}}$`);

/** Reads where a participant could host the plan from untrusted data: a few addresses written with the characters of an address or a host name, checked again before any connection, and a port. */
export function readEndpoint(field: Field, issues: IssueList): Endpoint | undefined {
  const record = readRecord(field, issues, ENDPOINT_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const items = readArray(
    childField(record, 'addresses', field.path),
    issues,
    MAX_ENDPOINT_ADDRESSES,
  );
  const port = readInteger(childField(record, 'port', field.path), issues, FIRST_PORT, LAST_PORT);
  if (items === undefined || port === undefined) {
    return undefined;
  }
  const addresses = items.map((_item, index) => itemField(items, index, field.path).value);
  if (!addresses.every((address) => typeof address === 'string' && ADDRESS_PATTERN.test(address))) {
    return undefined;
  }
  return { addresses: addresses.filter((address) => typeof address === 'string'), port };
}
