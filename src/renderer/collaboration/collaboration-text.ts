import type { GuestEndReason, NearbyPlan } from '../../preload/bridge-contract';
import { fileErrorMessage, fillMessage, type Messages } from '../i18n/messages';
import type { CollaborationFailure } from './collaboration-state.svelte';

const INITIALS_LENGTH = 2;
const IPV6_SEPARATOR = ':';

type EndText = Extract<
  keyof Messages['collaboration'],
  'wrongCode' | 'codeReplaced' | 'unreachable' | 'notPrivate'
>;

const END_TEXTS: Partial<Readonly<Record<GuestEndReason, EndText>>> = {
  WRONG_CODE: 'wrongCode',
  CODE_REPLACED: 'codeReplaced',
  UNREACHABLE: 'unreachable',
  NOT_PRIVATE: 'notPrivate',
};

/** Gives the initials shown for a person: the first two characters of their name, as a reader sees them, in capitals. */
export function initialsOf(name: string, locale: string): string {
  const segments = new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(name.trim());
  return Array.from(segments, (part) => part.segment)
    .slice(0, INITIALS_LENGTH)
    .join('')
    .toLocaleUpperCase(locale);
}

/** Gives the text that tells why a plan could not be shared or joined, or null for a choice the user cancelled. */
export function collaborationFailureText(
  messages: Messages,
  failure: CollaborationFailure,
): string | null {
  if (failure.code === 'NO_NAME') {
    return messages.collaboration.noName;
  }
  return fileErrorMessage(messages, failure.code);
}

/** Gives the text that tells why the connection to a host ended before its plan opened, naming the host. */
export function joinEndText(messages: Messages, reason: GuestEndReason, host: string): string {
  const text = messages.collaboration[END_TEXTS[reason] ?? 'connectionEnded'];
  return fillMessage(text, { host });
}

/** Chooses the address to join a plan found nearby at: its first IPv4 address, easier to reach across networks, or else its first address. */
export function preferredAddress(plan: NearbyPlan): string | null {
  return (
    plan.addresses.find((address) => !address.includes(IPV6_SEPARATOR)) ?? plan.addresses[0] ?? null
  );
}
