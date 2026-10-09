import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, extname, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveScopedPath } from "./scoped-path";

const IMAGE_MIMES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".heic": "image/heic", ".heif": "image/heif",
};

type ArchiveProcess = ChildProcess & { stdout: Readable; stderr: Readable };
interface FileDownloadsOptions {
  maxConcurrent?: number;
  spawnArchive?: (ticket: Pick<FileTicket, "path" | "dev" | "ino">) => ArchiveProcess;
}
interface FileTicket {
  path: string;
  name: string;
  download: boolean;
  directory: boolean;
  dev: number;
  ino: number;
  expires: number;
}

// The child verifies identity from its pinned cwd: rechecking in the daemon
// would leave an ancestor-symlink race before spawn resolves cwd. execve keeps
// that cwd and PID through to tar, so cancellation still kills the producer.
const ARCHIVE_LAUNCHER = `
  const { lstatSync } = require("node:fs");
  const [entry, dev, ino] = process.argv.slice(1);
  const stat = lstatSync(entry);
  if (!stat.isDirectory() || stat.dev !== Number(dev) || stat.ino !== Number(ino)) process.exit(1);
  process.execve("/bin/sh", ["sh", "-c", 'exec tar -czf - "$1"', "cube-folder-archive", entry], process.env);
`;

function spawnFolderArchive(ticket: Pick<FileTicket, "path" | "dev" | "ino">): ArchiveProcess {
  // No path is interpolated into executable code. The fixed shell only resolves
  // tar on PATH; its quoted positional argument starts with ./ to prevent flags.
  // Physical recursion (no -h/-H or trailing slash) never follows symlinks.
  return spawn(process.execPath, [
    "--input-type=commonjs", "-e", ARCHIVE_LAUNCHER,
    `./${basename(ticket.path) || "."}`, String(ticket.dev), String(ticket.ino),
  ], {
    cwd: dirname(ticket.path),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TAR_OPTIONS: "", ELECTRON_RUN_AS_NODE: "1" },
  });
}

/** Short-lived file/folder capabilities, minted only over the authenticated socket.
 * The HTTP URL carries no machine credential, root, or user-editable path. */
export class FileDownloads {
  private readonly tickets = new Map<string, FileTicket>();
  private readonly active = new Map<ArchiveProcess, Promise<void>>();
  constructor(
    private readonly now = () => Math.floor(Date.now() / 1000),
    private readonly options: FileDownloadsOptions = {},
  ) {}

  async mint(args: { root: string; path: string; download?: boolean }): Promise<{ token: string }> {
    const path = await realpath(resolveScopedPath(args.root, args.path));
    if (args.root !== "") {
      const root = await realpath(args.root);
      if (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error("path-escape");
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let directory: boolean;
    let dev: number;
    let ino: number;
    try {
      const stat = await file.stat();
      directory = stat.isDirectory();
      dev = stat.dev;
      ino = stat.ino;
      if (!stat.isFile() && !(directory && args.download === true)) throw new Error("Download must be a regular file or an explicit folder download");
    } finally { await file.close(); }
    for (const [key, value] of this.tickets) if (value.expires <= this.now()) this.tickets.delete(key);
    if (this.tickets.size >= 2048) this.tickets.delete(this.tickets.keys().next().value!);
    const token = randomBytes(32).toString("base64url");
    const selectedName = basename(args.path);
    const folderName = selectedName && selectedName !== "." && selectedName !== ".." ? selectedName : basename(path) || "root";
    const name = directory ? `${folderName}.tar.gz` : selectedName;
    this.tickets.set(token, { path, name, directory, dev, ino, download: args.download === true, expires: this.now() + 120 });
    return { token };
  }

  async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
    const ticket = this.tickets.get(token);
    if (!ticket || ticket.expires <= this.now()) { res.writeHead(401); res.end(); return; }
    try {
      if (ticket.directory && await realpath(ticket.path) !== ticket.path) throw new Error("path-escape");
      const file = await open(ticket.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (ticket.directory) {
          if (!stat.isDirectory() || stat.dev !== ticket.dev || stat.ino !== ticket.ino) throw new Error("Directory changed");
          await this.serveArchive(req, res, ticket);
          return;
        }
        if (!stat.isFile()) throw new Error("Not a regular file");
        const mime = IMAGE_MIMES[extname(ticket.name).toLowerCase()];
        const disposition = ticket.download || !mime ? "attachment" : "inline";
        const asciiName = ticket.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
        const encodedName = encodeURIComponent(ticket.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
        res.writeHead(200, {
          "Content-Type": mime ?? "application/octet-stream",
          "Content-Length": stat.size,
          "Content-Disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "sandbox",
        });
        await pipeline(file.createReadStream({ autoClose: false }), res);
      } finally { await file.close(); }
    } catch {
      if (!res.headersSent) { res.writeHead(404); res.end(); }
      else res.destroy();
    }
  }

  async close(): Promise<void> {
    this.tickets.clear();
    const active = [...this.active];
    for (const [child] of active) this.stopArchive(child);
    await Promise.all(active.map(([, done]) => done));
  }

  private stopArchive(child: ArchiveProcess): void {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  private async serveArchive(req: IncomingMessage, res: ServerResponse, ticket: FileTicket): Promise<void> {
    if (res.destroyed || req.aborted) return;
    if (this.active.size >= (this.options.maxConcurrent ?? 2)) {
      res.writeHead(429, { "Retry-After": "1", "Cache-Control": "no-store" });
      res.end();
      return;
    }
    const child = (this.options.spawnArchive ?? spawnFolderArchive)(ticket);
    let finished = false;
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    this.active.set(child, done);
    const cancel = (): void => {
      finished = true;
      this.stopArchive(child);
    };
    const fail = (): void => {
      if (finished) return;
      cancel();
      res.destroy(new Error("Folder archive failed"));
    };
    const resume = (): void => { child.stdout.resume(); };
    req.once("aborted", cancel);
    res.once("close", cancel);
    // Drain diagnostics without buffering them, and wait for successful process
    // exit before ending HTTP so a partial archive cannot appear successful.
    child.stderr.on("data", () => {});
    child.stderr.on("error", fail);
    child.once("error", fail);
    child.stdout.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      if (!finished && !res.write(chunk)) {
        child.stdout.pause();
        res.once("drain", resume);
      }
    });
    child.once("close", code => {
      if (!finished) {
        if (code !== 0) fail();
        else { finished = true; res.end(); }
      }
      req.off("aborted", cancel);
      res.off("close", cancel);
      res.off("drain", resume);
      this.active.delete(child);
      resolveDone();
    });
    const asciiName = ticket.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const encodedName = encodeURIComponent(ticket.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "sandbox",
    });
    res.flushHeaders();
    await done;
  }
}
