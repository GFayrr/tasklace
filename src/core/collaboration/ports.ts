export const DEFAULT_COLLABORATION_PORT = 47_313;
export const FIRST_PORT = 1;
export const LAST_PORT = 65_535;

/** Tells whether a number is a port a host can listen on. */
export function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= FIRST_PORT && port <= LAST_PORT;
}
