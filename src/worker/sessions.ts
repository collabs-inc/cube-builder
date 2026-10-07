// Custody/replay pattern adapted from src/main/ptyd/sessions.ts. This worker
// owns only Builder sessions and never connects to an installed Cube daemon.
import { spawn, type IPty } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { RingBuffer } from './ring-buffer.js';
import { TerminalModeTracker } from './terminal-modes.js';
import { BuilderError } from '../shared/errors.js';
import { decodeBase64 } from '../shared/bytes.js';
import type { SpawnParams, SessionInfo, ReadResult, TerminalEvent } from '../shared/terminal-protocol.js';

interface Session { info: SessionInfo; pty: IPty; ring: RingBuffer; modes: TerminalModeTracker; forgotten?: boolean; killed?: ReturnType<typeof setTimeout> }
function size(cols: number, rows: number) {
  if (![cols, rows].every(n => Number.isInteger(n) && n >= 1 && n <= 1000)) throw new BuilderError('invalid-size', 'Terminal dimensions must be between 1 and 1000');
}
export class TerminalSessions extends EventEmitter {
  private readonly sessions = new Map<string, Session>();
  private readonly requests = new Map<string, string>();
  private readonly forgotten = new Set<string>();
  spawn(params: SpawnParams): SessionInfo {
    if (!params || typeof params.requestId !== 'string' || !params.requestId || params.requestId.length > 160) throw new BuilderError('invalid-request', 'Missing terminal request ID');
    if (this.forgotten.has(params.requestId)) throw new BuilderError('session-closed', 'Terminal was explicitly closed');
    const known = this.requests.get(params.requestId);
    if (known) return { ...this.session(known).info };
    size(params.cols, params.rows);
    if (!params.command || typeof params.command !== 'string' || !Array.isArray(params.args) || params.args.some(x => typeof x !== 'string')) throw new BuilderError('invalid-command', 'Invalid command');
    if (!statSync(params.cwd).isDirectory()) throw new BuilderError('invalid-directory', 'Working directory is not a directory');
    const pty = spawn(params.command, params.args, { cwd: params.cwd, cols: params.cols, rows: params.rows, name: 'xterm-256color', env: { ...process.env, ...params.env, TERM: 'xterm-256color' }, encoding: null });
    const info: SessionInfo = { recovery: params.recovery, id: randomUUID(), requestId: params.requestId, pid: pty.pid, cwd: params.cwd, command: params.command, args: params.args, cols: params.cols, rows: params.rows, createdAt: new Date().toISOString(), exited: false, exitCode: null };
    const session: Session = { info, pty, ring: new RingBuffer(4 * 1024 * 1024), modes: new TerminalModeTracker() };
    this.sessions.set(info.id, session); this.requests.set(params.requestId, info.id);
    pty.onData(raw => {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      session.ring.write(bytes); session.modes.feed(bytes);
      this.emit('event', { type: 'data', id: info.id, data: bytes.toString('base64'), seq: session.ring.bytesWritten } satisfies TerminalEvent);
    });
    pty.onExit(({ exitCode }) => {
      info.exited = true; info.exitCode = exitCode;
      clearTimeout(session.killed);
      this.emit('event', { type: 'exit', id: info.id, exitCode } satisfies TerminalEvent);
      // Keep bounded diagnostics for ended sessions, without retaining a full
      // multi-megabyte allocation for every command ever launched.
      session.ring.compact(256 * 1024);
      if (session.forgotten) this.sessions.delete(info.id);
    });
    return { ...info };
  }
  private session(id: string): Session {
    const value = this.sessions.get(id);
    if (!value) throw new BuilderError('session-missing', 'Terminal session no longer exists');
    return value;
  }
  list(): SessionInfo[] { return [...this.sessions.values()].filter(s => !s.forgotten).map(s => ({ ...s.info })); }
  read(id: string, options: { since: number; maxBytes?: number }): ReadResult {
    const s = this.session(id);
    const maxBytes = options.maxBytes ?? 256 * 1024;
    if (!Number.isSafeInteger(options.since) || options.since < 0 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new BuilderError('invalid-cursor', 'Invalid replay cursor or size');
    const result = s.ring.readSince(options.since);
    const trimmed = result.data.length > maxBytes;
    let data = trimmed ? result.data.subarray(-maxBytes) : result.data;
    // A resetting tail may begin inside a UTF-8 sequence. Live/incremental
    // chunks remain byte-exact; xterm's streaming decoder joins their edges.
    if (trimmed || result.reset) { let offset = 0; while (offset < data.length && (data[offset]! & 0xc0) === 0x80) offset++; data = data.subarray(offset); }
    return { data: data.toString('base64'), seq: result.seq, start: result.seq - data.length, reset: result.reset || trimmed, modes: s.modes.restore(), exited: s.info.exited, exitCode: s.info.exitCode };
  }
  write(id: string, bytes: string): void {
    const s = this.session(id);
    if (s.info.exited) throw new BuilderError('session-exited', 'Terminal has exited');
    s.pty.write(decodeBase64(bytes, 512 * 1024, 'Terminal input'));
  }
  resize(id: string, cols: number, rows: number): void { size(cols, rows); const s = this.session(id); if (!s.info.exited) s.pty.resize(cols, rows); s.info.cols = cols; s.info.rows = rows; }
  kill(id: string): void {
    const s = this.session(id); if (s.info.exited || s.killed) return;
    try { process.kill(-s.info.pid, 'SIGHUP'); } catch {}
    try { s.pty.kill('SIGHUP'); } catch {}
    s.killed = setTimeout(() => { if (!s.info.exited) { try { process.kill(-s.info.pid, 'SIGKILL'); } catch {} try { s.pty.kill('SIGKILL'); } catch {} } }, 1500);
    s.killed.unref();
  }
  forget(id: string): void {
    const s = this.session(id); this.kill(id); s.forgotten = true;
    this.requests.delete(s.info.requestId); this.forgotten.add(s.info.requestId);
    if (this.forgotten.size > 1000) this.forgotten.delete(this.forgotten.values().next().value!);
    if (s.info.exited) this.sessions.delete(id);
  }
  async close(): Promise<void> {
    for (const s of this.sessions.values()) this.kill(s.info.id);
    const deadline = Date.now() + 3000;
    while ([...this.sessions.values()].some(s => !s.info.exited) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  }
}
