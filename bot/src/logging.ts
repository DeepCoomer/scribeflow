// Minimal structured logging (mirrors workers/scribeflow_workers/logging.py's
// shape: one JSON line per event, a short event name plus key/value fields).
// No dependency pulled in for this — both the bot and orchestrator processes
// just need greppable, machine-parseable stdout.

export type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

function log(
  level: string,
  name: string,
  event: string,
  fields?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    level,
    logger: name,
    event,
    ts: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

export function getLogger(name: string): Logger {
  return {
    info: (event, fields) => log("info", name, event, fields),
    warn: (event, fields) => log("warn", name, event, fields),
    error: (event, fields) => log("error", name, event, fields),
  };
}
