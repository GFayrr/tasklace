import type { FileFailureCode } from '../../preload/bridge-contract';
import type english from '../locales/en.json';

export type Messages = typeof english;
export type Language = 'en';
export type ShownFailureCode = Exclude<FileFailureCode, 'CANCELLED'>;

export interface PluralMessage {
  readonly one: string;
  readonly other: string;
}

const LOADERS: Readonly<Record<Language, () => Promise<{ readonly default: Messages }>>> = {
  en: () => import('../locales/en.json'),
};
const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

/** Loads the messages of one language only, the others staying out of memory. */
export async function loadMessages(language: Language): Promise<Messages> {
  const loaded = await LOADERS[language]();
  return loaded.default;
}

/** Returns the message telling the user why a file action failed, a cancelled action needing none. */
export function fileErrorMessage(messages: Messages, code: FileFailureCode): string | null {
  if (code === 'CANCELLED') {
    return null;
  }
  const shown: Readonly<Record<ShownFailureCode, string>> = messages.fileErrors;
  return shown[code];
}

/** Replaces each named placeholder of a message with its value, leaving unknown placeholders as they are. */
export function fillMessage(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER_PATTERN, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? (values[name] ?? placeholder) : placeholder,
  );
}

/** Chooses the singular or plural form of a message for a count, following the rules of the language, and writes the count in the regional format. */
export function countMessage(message: PluralMessage, count: number, locale: string): string {
  const form = new Intl.PluralRules(locale).select(count) === 'one' ? message.one : message.other;
  return fillMessage(form, { count: new Intl.NumberFormat(locale).format(count) });
}

/** Returns the message telling the user why a change was refused, a general one for a reason without its own message. */
export function editErrorMessage(messages: Messages, code: string): string {
  const known: Readonly<Record<string, string>> = messages.editErrors;
  return Object.hasOwn(known, code)
    ? (known[code] ?? messages.editErrors.NOT_POSSIBLE)
    : messages.editErrors.NOT_POSSIBLE;
}
