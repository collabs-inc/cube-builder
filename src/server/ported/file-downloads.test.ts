import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, lstat, readlink, rename, rm, symlink } from "node:fs/promises";
import childProcess, { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { renameSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { FileDownloads } from "./file-downloads";

let root: string;
let server: Server;
let origin: string;
let downloads: FileDownloads;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cube-download-test-"));
  downloads = new FileDownloads();
  server = createServer((req, res) => { void downloads.serve(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await downloads.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

test("a scoped download streams the exact binary with a safe suggested filename", async () => {
  await writeFile(join(root, "my report.bin"), Buffer.from([0, 255, 128]));
  const { token } = await downloads.mint({ root, path: "my report.bin", download: true });
  const response = await fetch(`${origin}/file?token=${token}`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 255, 128]));
  assert.match(response.headers.get("content-disposition")!, /attachment;.*my%20report.bin/);
  assert.equal(response.headers.get("content-length"), "3");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("image previews stay inline, and a token cannot be redirected to a different path", async () => {
  await writeFile(join(root, "shot.png"), "image");
  const { token } = await downloads.mint({ root, path: "shot.png" });
  const response = await fetch(`${origin}/file?token=${token}&path=/etc/passwd`);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(response.headers.get("content-disposition")!, /^inline;/);
  assert.equal(await response.text(), "image");
  assert.equal((await fetch(`${origin}/file?token=invalid`)).status, 401);
});

test("expired tickets, directories, and paths escaping the root are refused", async () => {
  let now = 0;
  downloads = new FileDownloads(() => now);
  await writeFile(join(root, "a.txt"), "hello");
  const { token } = await downloads.mint({ root, path: "a.txt" });
  now = 121;
  assert.equal((await fetch(`${origin}/file?token=${token}`)).status, 401);
  await assert.rejects(downloads.mint({ root, path: "../outside" }), /path-escape/);
  await assert.rejects(downloads.mint({ root, path: "." }), /regular file/);
  await symlink(tmpdir(), join(root, "outside"));
  await assert.rejects(downloads.mint({ root, path: "outside" }), /path-escape/);
});

test("folder downloads preserve binary files, dotfiles, nested and empty directories", async () => {
  const folder = join(root, "my project");
  await mkdir(join(folder, "nested", "empty"), { recursive: true });
  const bytes = Buffer.from([0, 255, 128, 10, 0]);
  await writeFile(join(folder, "nested", "payload.bin"), bytes);
  await writeFile(join(folder, ".settings"), "hidden\n");
  const { token } = await downloads.mint({ root, path: "my project", download: true });
  const response = await fetch(`${origin}/file?token=${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/gzip");
  assert.match(response.headers.get("content-disposition")!, /attachment;.*my%20project.tar.gz/);
  assert.equal(response.headers.get("content-length"), null);
  const extracted = join(root, "extracted");
  await mkdir(extracted);
  const result = spawnSync("tar", ["-xzf", "-", "-C", extracted], {
    input: Buffer.from(await response.arrayBuffer()), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(join(extracted, "my project", "nested", "payload.bin")), bytes);
  assert.equal(await readFile(join(extracted, "my project", ".settings"), "utf8"), "hidden\n");
  assert.equal((await lstat(join(extracted, "my project", "nested", "empty"))).isDirectory(), true);
});

test("folder archives preserve symlinks without reading their targets", async () => {
  await mkdir(join(root, "selected"));
  await mkdir(join(root, "outside"));
  await writeFile(join(root, "outside", "secret.txt"), "DO_NOT_ARCHIVE");
  await symlink("../outside", join(root, "selected", "link"));
  const { token } = await downloads.mint({ root, path: "selected", download: true });
  const response = await fetch(`${origin}/file?token=${token}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const listed = spawnSync("tar", ["-tzf", "-"], { input: bytes, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.doesNotMatch(listed.stdout, /secret.txt/);
  const extracted = join(root, "extracted");
  await mkdir(extracted);
  const result = spawnSync("tar", ["-xzf", "-", "-C", extracted], { input: bytes, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await lstat(join(extracted, "selected", "link"))).isSymbolicLink(), true);
  assert.equal(await readlink(join(extracted, "selected", "link")), "../outside");
});

test("a folder ticket rejects a selected directory replaced by a symlink", async () => {
  await mkdir(join(root, "selected"));
  await mkdir(join(root, "outside"));
  await writeFile(join(root, "outside", "secret.txt"), "DO_NOT_ARCHIVE");
  const { token } = await downloads.mint({ root, path: "selected", download: true });
  await rename(join(root, "selected"), join(root, "original"));
  await symlink(join(root, "outside"), join(root, "selected"));
  assert.equal((await fetch(`${origin}/file?token=${token}`)).status, 404);
});

test("replacing the selected directory at archive startup rejects the download", async () => {
  await mkdir(join(root, "selected"));
  await mkdir(join(root, "outside"));
  await writeFile(join(root, "outside", "secret.txt"), "DO_NOT_ARCHIVE");
  const { token } = await downloads.mint({ root, path: "selected", download: true });
  const originalSpawn = childProcess.spawn;
  let swapped = false;
  childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
    if (!swapped) {
      swapped = true;
      renameSync(join(root, "selected"), join(root, "original"));
      symlinkSync(join(root, "outside"), join(root, "selected"));
    }
    return originalSpawn(...args);
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    const response = await fetch(`${origin}/file?token=${token}`);
    await assert.rejects(response.arrayBuffer());
    assert.equal(swapped, true);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
});

test("archive names containing quotes, shell substitutions, and leading dashes stay literal", async () => {
  const name = "--folder $(touch INJECTED) 'quoted'";
  await mkdir(join(root, name));
  await writeFile(join(root, name, "saved.txt"), "saved");
  const { token } = await downloads.mint({ root, path: name, download: true });
  const response = await fetch(`${origin}/file?token=${token}`);
  const result = spawnSync("tar", ["-xzOf", "-", `./${name}/saved.txt`], {
    input: Buffer.from(await response.arrayBuffer()), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "saved");
  await assert.rejects(lstat(join(root, "INJECTED")), { code: "ENOENT" });
});

test("replacing an ancestor at archive startup cannot export an outside directory", async () => {
  await mkdir(join(root, "allowed", "parent", "selected"), { recursive: true });
  await mkdir(join(root, "outside", "selected"), { recursive: true });
  await writeFile(join(root, "outside", "selected", "secret.txt"), "DO_NOT_ARCHIVE");
  const { token } = await downloads.mint({ root: join(root, "allowed"), path: "parent/selected", download: true });
  const originalSpawn = childProcess.spawn;
  let swapped = false;
  childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
    if (!swapped) {
      swapped = true;
      renameSync(join(root, "allowed", "parent"), join(root, "allowed", "original"));
      symlinkSync(join(root, "outside"), join(root, "allowed", "parent"));
    }
    return originalSpawn(...args);
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    const response = await fetch(`${origin}/file?token=${token}`);
    await assert.rejects(response.arrayBuffer(), "ancestor changes must abort the download");
    assert.equal(swapped, true);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
});

test("folder tickets expire and directory previews remain refused", async () => {
  let now = 0;
  downloads = new FileDownloads(() => now);
  await mkdir(join(root, "selected"));
  await assert.rejects(downloads.mint({ root, path: "selected", download: false }), /regular file/);
  const { token } = await downloads.mint({ root, path: "selected", download: true });
  now = 121;
  assert.equal((await fetch(`${origin}/file?token=${token}`)).status, 401);
});

test("folder symlink aliases use the selected name for the download", async () => {
  await mkdir(join(root, "real"));
  await symlink("real", join(root, "alias"));
  const { token } = await downloads.mint({ root, path: "alias", download: true });
  const response = await fetch(`${origin}/file?token=${token}`);
  assert.match(response.headers.get("content-disposition")!, /filename="alias.tar.gz"/);
  await response.arrayBuffer();
});

function childClosed(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("archive subprocess did not close")), 2000);
    child.once("close", () => { clearTimeout(timeout); resolve(); });
  });
}

test("archive cancellation kills the child and releases the concurrency slot", async () => {
  const children: ChildProcess[] = [];
  downloads = new FileDownloads(undefined, {
    maxConcurrent: 1,
    spawnArchive: () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      return child;
    },
  });
  await mkdir(join(root, "selected"));
  const { token } = await downloads.mint({ root, path: "selected", download: true });
  const abort = new AbortController();
  const first = await fetch(`${origin}/file?token=${token}`, { signal: abort.signal });
  assert.equal(first.status, 200, "headers must arrive even before tar emits data");
  const second = await fetch(`${origin}/file?token=${token}`);
  assert.equal(second.status, 429);
  const closed = childClosed(children[0]!);
  abort.abort();
  await closed;
  assert.equal(children[0]!.signalCode, "SIGKILL");
  const third = await fetch(`${origin}/file?token=${token}`);
  assert.equal(third.status, 200);
  const lastClosed = childClosed(children[1]!);
  await downloads.close();
  await lastClosed;
  assert.equal(children[1]!.signalCode, "SIGKILL");
});

test("tar errors terminate the HTTP body instead of completing a corrupt archive", async () => {
  downloads = new FileDownloads(undefined, {
    spawnArchive: () => spawn(process.execPath, ["-e", "process.stdout.write('partial'); process.exit(1)"], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
  });
  const { token } = await downloads.mint({ root, path: ".", download: true });
  const response = await fetch(`${origin}/file?token=${token}`);
  await assert.rejects(response.arrayBuffer());
});

test("a missing tar executable terminates the HTTP body", async () => {
  downloads = new FileDownloads(undefined, {
    spawnArchive: () => spawn(join(root, "missing-tar"), [], { stdio: ["ignore", "pipe", "pipe"] }),
  });
  const { token } = await downloads.mint({ root, path: ".", download: true });
  await assert.rejects(async () => {
    const response = await fetch(`${origin}/file?token=${token}`);
    await response.arrayBuffer();
  });
});
