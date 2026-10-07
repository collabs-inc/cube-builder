export class BuilderError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function errorPayload(error: unknown): { code: string; message: string } {
  if (error instanceof BuilderError) return { code: error.code, message: error.message };
  return { code: 'operation-failed', message: error instanceof Error ? error.message : 'Operation failed' };
}
