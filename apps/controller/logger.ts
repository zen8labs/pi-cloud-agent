/**
 * Structured logs, one JSON object per line.
 *
 * Small on purpose. The record of what happened *during* a run is the event log
 * in Postgres; these lines are for the controller's own behavior — claims,
 * provisioning, reconciliation, failures.
 *
 * The level is passed in rather than read from global configuration, so that
 * constructing a logger never depends on a loaded environment. A logger that
 * throws while reporting an error is worse than a noisy one.
 */

/** `silent` exists so tests that deliberately exercise failure paths stay quiet. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger carrying extra fields on every line, e.g. { runId }. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  fields?: LogFields;
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, cause: value.cause };
  }
  return value;
}

export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const base = options.fields ?? {};

  const write = (at: LogLevel, message: string, fields?: LogFields) => {
    if (LEVELS[at] < LEVELS[level]) return;
    const record: LogFields = {
      at: new Date().toISOString(),
      level: at,
      logger: name,
      message,
      ...base,
      ...fields,
    };
    if ("error" in record) record.error = serializeError(record.error);
    process.stdout.write(`${JSON.stringify(record)}\n`);
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (fields) => createLogger(name, { level, fields: { ...base, ...fields } }),
  };
}
