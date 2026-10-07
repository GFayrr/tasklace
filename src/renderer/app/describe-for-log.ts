const CAUSE_PREFIX = 'Caused by: ';
const INNER_PREFIX = 'Inner error ';
const LINE_BREAK = '\n';
const VALUE_SEPARATOR = ' ';

export interface LogTarget {
  error: (...values: unknown[]) => void;
  warn: (...values: unknown[]) => void;
}

/** Writes a value as the text the log keeps: a string as it is, an error with its stack, cause and inner errors, anything else as JSON with its errors written out, or as its plain text when it cannot be written as JSON, such as a value that refers to itself. */
export function describeForLog(value: unknown, written = new WeakSet<Error>()): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return describeError(value, written);
  }
  try {
    const json = JSON.stringify(value, (_key, field: unknown) =>
      field instanceof Error ? describeError(field, written) : field,
    ) as string | undefined;
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/** Makes the errors and warnings a console reports reach the log as text, the page only sending the log the text of each message. */
export function writeConsoleAsText(target: LogTarget): void {
  const { error, warn } = target;
  target.error = (...values) => {
    error(values.map((value) => describeForLog(value)).join(VALUE_SEPARATOR));
  };
  target.warn = (...values) => {
    warn(values.map((value) => describeForLog(value)).join(VALUE_SEPARATOR));
  };
}

/** Writes an error with its stack, then its cause and the errors it gathers, each on lines of their own, an error already written being named only once more so that a cause that loops ends. */
function describeError(error: Error, written: WeakSet<Error>): string {
  const head = error.stack ?? `${error.name}: ${error.message}`;
  if (written.has(error)) {
    return `${error.name}: ${error.message}`;
  }
  written.add(error);
  const lines = [head];
  if (error.cause !== undefined) {
    lines.push(`${CAUSE_PREFIX}${describeForLog(error.cause, written)}`);
  }
  if (error instanceof AggregateError) {
    (error.errors as unknown[]).forEach((inner, index) => {
      lines.push(`${INNER_PREFIX}${String(index + 1)}: ${describeForLog(inner, written)}`);
    });
  }
  return lines.join(LINE_BREAK);
}

/** Returns what an error event of the window reports: its error, or, when the browser gives none, such as for a script of another origin, its message and where it happened. */
export function errorOfEvent(event: ErrorEvent): unknown {
  const error: unknown = event.error;
  if (error !== null && error !== undefined) {
    return error;
  }
  return `${event.message} (${event.filename}:${String(event.lineno)}:${String(event.colno)})`;
}
