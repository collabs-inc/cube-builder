import { randomBytes } from 'node:crypto';
import { realpath, stat, open } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { Registry } from './registry.js';
import { isWithin } from './repos.js';
import { BuilderError } from '../shared/errors.js';
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.pdf': 'application/pdf', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.txt': 'text/plain' };
interface Capability { root: string; file: string; tree: boolean; expiresAt: number }
export class Previews {
  private tokens = new Map<string, Capability>();
  constructor(private registry: Registry, private lifetime = 15 * 60_000) {}
  async create(itemId: string): Promise<{ url: string; expiresAt: number }> {
    const item = this.registry.snapshot().items.find(i => i.id === itemId);
    if (!item || item.type === 'term') throw new BuilderError('item-missing', 'Preview file no longer exists');
    const file = await realpath(item.filePath); const root = dirname(file);
    const token = randomBytes(24).toString('base64url'); const expiresAt = Date.now() + this.lifetime;
    for (const [key, value] of this.tokens) if (value.expiresAt <= Date.now()) this.tokens.delete(key);
    if (this.tokens.size >= 1024) this.tokens.delete(this.tokens.keys().next().value!);
    this.tokens.set(token, { root, file, tree: item.type === 'artifact', expiresAt });
    return { url: `/preview/${token}/${encodeURIComponent(basename(file))}`, expiresAt };
  }
  async serve(pathname: string, response: ServerResponse, range?: string): Promise<void> {
    const match = /^\/preview\/([^/]+)\/(.*)$/.exec(pathname);
    const capability = match ? this.tokens.get(match[1]!) : undefined;
    if (!capability || capability.expiresAt <= Date.now()) { response.writeHead(404).end('Preview expired; reopen the file'); return; }
    const relative = decodeURIComponent(match![2]!);
    if (relative.split(/[\\/]/).some(part => part.startsWith('.')) || relative.includes('\0')) { response.writeHead(403).end(); return; }
    const lexical = resolve(capability.root, relative);
    if (!isWithin(capability.root, lexical)) { response.writeHead(403).end(); return; }
    let canonical: string;
    try { canonical = await realpath(lexical); } catch { response.writeHead(404).end(); return; }
    if (!isWithin(capability.root, canonical) || (!capability.tree && canonical !== capability.file)) { response.writeHead(403).end(); return; }
    // O_NOFOLLOW rejects swapping the final component to a link after realpath.
    const { constants } = await import('node:fs');
    const fd = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await fd.stat(); if (!s.isFile()) { response.writeHead(404).end(); return; }
      let start = 0, end = s.size - 1, status = 200;
      if (range) {
        const parsed = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!parsed) { response.writeHead(416, { 'content-range': `bytes */${s.size}` }).end(); return; }
        start = Number(parsed[1]); end = parsed[2] ? Math.min(Number(parsed[2]), end) : end;
        if (start > end || start < 0) { response.writeHead(416, { 'content-range': `bytes */${s.size}` }).end(); return; }
        status = 206;
      }
      response.writeHead(status, {
        'content-type': TYPES[extname(canonical).toLowerCase()] ?? 'application/octet-stream',
        'content-length': Math.max(0, end - start + 1), 'accept-ranges': 'bytes',
        ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${s.size}` } : {}),
        'content-security-policy': "sandbox allow-scripts allow-forms allow-downloads allow-modals allow-popups",
        // Capabilities are already the read authority. Opaque sandbox modules
        // and fonts need anonymous CORS; control routes never send this header.
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
      });
      if (s.size === 0) { response.end(); return; }
      await pipeline(fd.createReadStream({ start, end, autoClose: false }), response);
    } finally { await fd.close(); }
  }
}
