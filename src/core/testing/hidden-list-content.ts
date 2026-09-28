import * as Y from 'yjs';

/** Inserts list content into a shared map, as a forged update can although no map method would. */
export function hideListContent(map: Y.Map<unknown>): void {
  const insert: unknown = Reflect.get(Y.Array.prototype, 'insert');
  if (typeof insert !== 'function') {
    throw new TypeError('Missing list insertion in Yjs');
  }
  Reflect.apply(insert, map, [0, ['hidden']]);
}
