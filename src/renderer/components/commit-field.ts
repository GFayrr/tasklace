import type { Attachment } from 'svelte/attachments';

/** Hands over the value of a field when the user leaves it or presses Enter in it, only when it differs from the value shown, so that a date typed piece by piece makes a single change. */
export function commitField(
  shown: () => string,
  commit: (value: string, field: HTMLInputElement) => void,
): Attachment<HTMLInputElement> {
  return (field) => {
    const send = (): void => {
      if (field.value !== shown()) {
        commit(field.value, field);
      }
    };
    const sendOnEnter = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') {
        send();
      }
    };
    field.addEventListener('blur', send);
    field.addEventListener('keydown', sendOnEnter);
    return () => {
      field.removeEventListener('blur', send);
      field.removeEventListener('keydown', sendOnEnter);
    };
  };
}
