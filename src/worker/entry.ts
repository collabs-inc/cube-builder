import { startWorkerServer } from './server.js';
const socketPath = process.argv[2];
if (!socketPath) throw new Error('Missing worker socket path');
process.umask(0o077);
const server = await startWorkerServer(socketPath);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void server.close(); });
