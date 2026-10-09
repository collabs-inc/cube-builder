/** SSH telemetry's allowlisted wire contract. Never add raw OpenSSH fields. */
export interface SshSetupProperties {
  trigger: 'automatic' | 'interactive';
  outcome: 'succeeded' | 'failed' | 'skipped';
  reason: 'none' | 'opted_out' | 'no_keygen' | 'config_unwritable' | 'bad_hostname' | 'other';
  elapsed_ms: number;
}
export interface SshKeyOperationProperties {
  operation: 'authorize' | 'revoke' | 'revoke-others';
  outcome: 'succeeded' | 'failed';
  reason: 'none' | 'unavailable' | 'rejected' | 'other';
  elapsed_ms: number;
}
export interface SshServerProperties {
  ssh_connection_authenticated: { connection_id: string; auth_method: 'publickey' };
  ssh_authentication_failed: { connection_id: string; reason: 'key_rejected' | 'invalid_user' | 'other' };
  ssh_connection_closed: { connection_id: string; reason: 'disconnected' | 'transport_error' | 'other'; duration_ms?: number };
  ssh_telemetry_health: { collector_version: string; parser_version: string; queue_depth: number; oldest_pending_age_ms: number; known_dropped: number; unknown_records: number; coverage_gaps: number; coverage: 'best_effort' | 'degraded' };
}
export type SshServerEvent = { [K in keyof SshServerProperties]: {
  schema_version: 1; uuid: string; timestamp: string; event: K; properties: SshServerProperties[K];
} }[keyof SshServerProperties];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const member = <T extends string>(v: unknown, choices: readonly T[]): v is T => typeof v === 'string' && choices.includes(v as T);
/** Reconstruct, rather than spread, untrusted machine input. */
export function sanitizeSshServerEvent(input: unknown, nowMs: number): SshServerEvent | null {
  if (!record(input) || input.schema_version !== 1 || !uuid(input.uuid) || typeof input.timestamp !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(input.timestamp) || !record(input.properties)) return null;
  const time = Date.parse(input.timestamp);
  if (!Number.isFinite(time) || !Number.isFinite(nowMs) || time < nowMs - 604800000 || time > nowMs + 300000) return null;
  const base = { schema_version: 1 as const, uuid: input.uuid, timestamp: input.timestamp };
  const p = input.properties;
  switch (input.event) {
    case 'ssh_connection_authenticated':
      return uuid(p.connection_id) && p.auth_method === 'publickey' ? { ...base, event: input.event, properties: { connection_id: p.connection_id, auth_method: 'publickey' } } : null;
    case 'ssh_authentication_failed':
      return uuid(p.connection_id) && member(p.reason, ['key_rejected', 'invalid_user', 'other']) ? { ...base, event: input.event, properties: { connection_id: p.connection_id, reason: p.reason } } : null;
    case 'ssh_connection_closed': {
      if (!uuid(p.connection_id) || !member(p.reason, ['disconnected', 'transport_error', 'other']) || (p.duration_ms !== undefined && !integer(p.duration_ms, 31536000000))) return null;
      return { ...base, event: input.event, properties: { connection_id: p.connection_id, reason: p.reason, ...(p.duration_ms === undefined ? {} : { duration_ms: p.duration_ms as number }) } };
    }
    case 'ssh_telemetry_health': {
      const version = (v: unknown): v is string => typeof v === 'string' && /^\d{1,4}(?:\.\d{1,4}){0,2}$/.test(v);
      if (!version(p.collector_version) || !version(p.parser_version) || !integer(p.queue_depth, 50000) || !integer(p.oldest_pending_age_ms, 604800000) || !integer(p.known_dropped) || !integer(p.unknown_records) || !integer(p.coverage_gaps) || !member(p.coverage, ['best_effort', 'degraded'])) return null;
      return { ...base, event: input.event, properties: { collector_version: p.collector_version, parser_version: p.parser_version, queue_depth: p.queue_depth, oldest_pending_age_ms: p.oldest_pending_age_ms, known_dropped: p.known_dropped, unknown_records: p.unknown_records, coverage_gaps: p.coverage_gaps, coverage: p.coverage } };
    }
    default: return null;
  }
}
