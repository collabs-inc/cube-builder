// Ported from src/main/cubed/files.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { extname } from 'node:path';
export function suffixedName(filename: string, n: number): string {
  const ext = extname(filename);
  return `${filename.slice(0, filename.length - ext.length)} ${n}${ext}`;
}
