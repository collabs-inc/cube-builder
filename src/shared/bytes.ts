import { BuilderError } from './errors.js';
/** Canonical decoding avoids backtracking regexes on multi-megabyte input. */
export function decodeBase64(value: unknown, maxBytes: number, label: string): Buffer {
  if (typeof value !== 'string') throw new BuilderError('invalid-bytes', `Invalid ${label} bytes`);
  if (value.length > Math.ceil(maxBytes / 3) * 4) throw new BuilderError('too-large', `${label} exceeds ${maxBytes / 1024 / 1024} MiB`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes) throw new BuilderError('too-large', `${label} exceeds ${maxBytes / 1024 / 1024} MiB`);
  if (bytes.toString('base64') !== value) throw new BuilderError('invalid-bytes', `Invalid ${label} bytes`);
  return bytes;
}
