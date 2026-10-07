import { mkdir, readFile, writeFile, cp, rename, rm, stat, open } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WorkerClient } from './worker-client.js';
import { BuilderError } from '../shared/errors.js';

const require = createRequire(import.meta.url);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export function workerSocketPath(stateDir: string): string {
  const key = createHash('sha256').update(resolve(stateDir)).digest('hex').slice(0, 20);
  return join(tmpdir(), `builder-${process.getuid?.() ?? 'user'}-${key}`, 'worker.sock');
}
async function connectExisting(socket: string): Promise<WorkerClient | null> {
  try { return await WorkerClient.connect(socket); }
  catch (error) {
    // Only absence/refusal permits starting a new worker. A protocol failure
    // or a slow existing worker must never be mistaken for an absent owner.
    if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}
async function installRuntime(stateDir: string, entry: string): Promise<string> {
  const bytes = await readFile(entry);
  const ptyRoot = dirname(require.resolve('node-pty/package.json'));
  const metadata = await readFile(join(ptyRoot, 'package.json'));
  const key = createHash('sha256').update(bytes).update(metadata).update(`${process.platform}-${process.arch}-${process.versions.modules}`).digest('hex').slice(0, 24);
  const destination = join(stateDir, 'runtime', key);
  try { await stat(join(destination, 'ready')); return join(destination, 'worker.js'); } catch {}
  const staging = `${destination}.tmp-${randomUUID()}`;
  await mkdir(join(staging, 'node_modules', 'node-pty'), { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(staging, 'worker.js'), bytes);
    await writeFile(join(staging, 'package.json'), '{"type":"module"}\n');
    // node-pty loads its JS, platform addon and (on macOS) spawn helper lazily.
    // Keep all runtime variants; build sources/header packages are not needed.
    for (const name of ['package.json', 'LICENSE', 'lib', 'build/Release', 'prebuilds']) {
      const from = join(ptyRoot, name), to = join(staging, 'node_modules', 'node-pty', name);
      try { await stat(from); } catch { continue; }
      await mkdir(dirname(to), { recursive: true });
      await cp(from, to, { recursive: true, dereference: true });
    }
    await writeFile(join(staging, 'ready'), key);
    await rename(staging, destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return join(destination, 'worker.js');
}
export async function ensureWorker(stateDir: string, options: { workerEntry?: string } = {}): Promise<WorkerClient> {
  const socket = workerSocketPath(stateDir);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  const socketDir = await stat(dirname(socket));
  if ((socketDir.mode & 0o077) !== 0 || (process.getuid && socketDir.uid !== process.getuid())) throw new BuilderError('unsafe-worker-directory', 'Worker socket directory is not private');
  const existing = await connectExisting(socket); if (existing) return existing;
  const lock = join(dirname(socket), 'starting.lock');
  for (let attempt = 0; attempt < 200; attempt++) {
    let handle;
    try { handle = await open(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const running = await connectExisting(socket); if (running) return running;
      // A failed starter leaves a lock. Its age bounds recovery without
      // signaling any PID. Recheck inode ownership before unlinking it.
      const before = await stat(lock).catch(() => null);
      if (before && Date.now() - before.mtimeMs > 30_000) {
        const after = await stat(lock).catch(() => null);
        if (after?.ino === before.ino) await rm(lock, { force: true });
      }
      await sleep(100); continue;
    }
    try {
      const raced = await connectExisting(socket); if (raced) return raced;
      await rm(socket, { force: true });
      const entry = options.workerEntry ?? fileURLToPath(new URL('./worker.js', import.meta.url));
      // Source tests execute under src/server; packaged server is in dist.
      const resolvedEntry = options.workerEntry ? entry : await stat(entry).then(() => entry).catch(() => resolve('dist/worker.js'));
      const runtime = await installRuntime(stateDir, resolvedEntry);
      const child = spawn(process.execPath, [runtime, socket], { cwd: stateDir, detached: true, stdio: 'ignore', env: { ...process.env, BUILDER_STATE_DIR: stateDir } });
      child.unref();
      let spawnError: Error | undefined;
      child.on('error', error => { spawnError = error; });
      for (let i = 0; i < 100; i++) {
        if (spawnError) throw spawnError;
        const client = await connectExisting(socket); if (client) return client;
        if (child.exitCode !== null) throw new BuilderError('worker-start-failed', `Terminal worker exited (${child.exitCode})`);
        await sleep(50);
      }
      throw new BuilderError('worker-start-failed', 'Terminal worker did not become ready');
    } finally { await handle.close(); await rm(lock, { force: true }); }
  }
  throw new BuilderError('worker-busy', 'Another server is starting the terminal worker; retry shortly');
}
