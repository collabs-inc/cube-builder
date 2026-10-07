import { BuilderError } from '../shared/errors.js';
export function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new BuilderError('invalid-request', `Invalid ${label}`);
  return value;
}
export function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new BuilderError('invalid-request', `Invalid ${label}`);
  return value as number;
}
