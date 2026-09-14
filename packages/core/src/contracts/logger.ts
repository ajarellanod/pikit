/** Structured logger (SPEC §4.5 `logger`). Fields are data, never interpolated into the message. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Default logger: `console`, which exists on every target. */
export const consoleLogger: Logger = {
  debug: (message, fields) => (fields ? console.debug(message, fields) : console.debug(message)),
  info: (message, fields) => (fields ? console.info(message, fields) : console.info(message)),
  warn: (message, fields) => (fields ? console.warn(message, fields) : console.warn(message)),
  error: (message, fields) => (fields ? console.error(message, fields) : console.error(message)),
};

/** Logger that discards everything. For tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
