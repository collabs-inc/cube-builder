export interface Request { id: string; method: string; params: Record<string, unknown> }
export type Reply = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: { code: string; message: string } };
export function isRequest(value: unknown): value is Request {
  if (!value || typeof value !== 'object') return false;
  const r = value as Request;
  return typeof r.id === 'string' && r.id.length > 0 && r.id.length < 160
    && typeof r.method === 'string' && r.method.length < 100
    && !!r.params && typeof r.params === 'object' && !Array.isArray(r.params);
}
