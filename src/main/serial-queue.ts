/** Returns a function running tasks one after the other, in the order they were given, whatever the outcome of the previous one. */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = last.then(task, task);
    last = next.catch(() => undefined);
    return next;
  };
}
