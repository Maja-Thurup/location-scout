/**
 * Tiny structured logger.
 *
 * In production, logs become Vercel function logs (and Sentry breadcrumbs
 * via the @sentry/nextjs auto-instrumentation). In development, prints
 * pretty-ish JSON to stderr.
 *
 * Use this instead of bare `console.*` so we have a single chokepoint to
 * change (e.g. switch to pino or send to Datadog) without touching every
 * call site.
 */

type Level = "debug" | "info" | "warn" | "error";

type LogPayload = {
  level: Level;
  msg: string;
  ts: string;
  [key: string]: unknown;
};

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const payload: LogPayload = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...fields,
  };

  const line = JSON.stringify(payload);

  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>): void => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>): void => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>): void => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>): void => emit("error", msg, fields),
};
