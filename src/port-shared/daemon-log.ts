// One line per transition, machine-parseable: see the spec's §12 "Line shape".
export type LogFields = Record<string, string | number | boolean | null | undefined>;

function formatValue(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  return /[\s="]/.test(value) ? JSON.stringify(value) : value;
}

export function formatLine(prefix: string, event: string, fields: LogFields, now: () => Date = () => new Date()): string {
  const parts = [now().toISOString(), prefix, event];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

export interface DaemonLogger {
  (event: string, fields?: LogFields): void;
  child(fixed: LogFields): DaemonLogger;
}

export function makeLogger(
  prefix: string,
  fixed: LogFields,
  write: (s: string) => void = (s) => process.stderr.write(s),
  now?: () => Date,
): DaemonLogger {
  const log = ((event: string, fields: LogFields = {}) => {
    write(`${formatLine(prefix, event, { ...fixed, ...fields }, now)}\n`);
  }) as DaemonLogger;
  log.child = (more) => makeLogger(prefix, { ...fixed, ...more }, write, now);
  return log;
}

export function machineIdFromEnv(env: Record<string, string | undefined>, actor: "cubed" | "supervisor" = "cubed"): string {
  if (env.FLY_MACHINE_ID) return env.FLY_MACHINE_ID;
  return actor === "cubed" && (env.CUBE_MACHINE_ENV === "production" || env.CUBE_MACHINE_ENV === "staging")
    ? "unknown" : "local";
}
