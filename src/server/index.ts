import { startServer } from './http.js';
import { stateDirectory } from './state-paths.js';
const port = Number(process.env.PORT ?? 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
const app = await startServer({ port, stateDir: stateDirectory() });
console.log(`Cube Builder: http://127.0.0.1:${app.port}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); }
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
