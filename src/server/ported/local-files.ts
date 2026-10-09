import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { DirEntry } from "../../port-shared/types.js";

export type { DirEntry };

/**
 * Lists a directory verbatim: no ignore rules, and no per-folder file counts.
 * Both are policy, and policy belongs to the caller — `CubedFiles.readdir`
 * applies whichever the request asked for, on the machine holding the files.
 */
export async function fsReadDir(dirPath: string): Promise<DirEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return Promise.all(
    entries.map(async (e) => {
      let createdAt = "";
      let modifiedAt = "";
      if (e.isFile()) {
        try {
          const s = await stat(join(dirPath, e.name));
          createdAt = s.birthtime.toISOString();
          modifiedAt = s.mtime.toISOString();
        } catch {}
      }
      return {
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
        isSymlink: e.isSymbolicLink(),
        createdAt,
        modifiedAt,
      };
    }),
  );
}

export async function fsReadFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf-8");
}

export interface WriteResult {
  ok: boolean;
  mtime: string;
  conflict?: boolean;
}

export async function fsWriteFile(
  filePath: string,
  content: string,
  expectedMtime?: string,
): Promise<WriteResult> {
  if (expectedMtime) {
    try {
      const before = await stat(filePath);
      if (before.mtime.toISOString() !== expectedMtime) {
        return {
          ok: false,
          mtime: before.mtime.toISOString(),
          conflict: true,
        };
      }
    } catch {
      // File doesn't exist yet — no conflict
    }
  }

  await writeFile(filePath, content, "utf-8");
  const after = await stat(filePath);
  return { ok: true, mtime: after.mtime.toISOString() };
}

export function atomicWriteFileSync(
  filePath: string,
  data: string,
  mode?: number,
): void {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, data, mode === undefined ? { encoding: "utf-8" } : { encoding: "utf-8", mode });
  renameSync(tmpPath, filePath);
  // The mode set on the tmp file above already carries through rename on
  // POSIX, but a caller passing `mode` is writing something sensitive
  // (secrets) — chmod again after the rename so that holds regardless.
  if (mode !== undefined) chmodSync(filePath, mode);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function fsRename(
  oldPath: string,
  newName: string,
): Promise<string> {
  const dir = dirname(oldPath);
  let target = join(dir, newName);
  if (oldPath === target) return oldPath;

  const ext = newName.slice(newName.lastIndexOf("."));
  const stem = newName.slice(0, newName.lastIndexOf("."));
  let n = 2;
  while (await fileExists(target)) {
    target = join(dir, `${stem} ${n}${ext}`);
    n++;
  }

  await rename(oldPath, target);
  return target;
}

export async function fsMkdir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function fsMove(
  oldPath: string,
  newParentDir: string,
): Promise<string> {
  const name = basename(oldPath);
  let target = join(newParentDir, name);

  if (oldPath === target) return oldPath;

  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let n = 2;
  while (await fileExists(target)) {
    target = join(newParentDir, ext ? `${stem} ${n}${ext}` : `${stem} ${n}`);
    n++;
  }

  await rename(oldPath, target);
  return target;
}
