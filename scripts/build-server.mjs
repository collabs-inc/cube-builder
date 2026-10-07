import { build } from 'esbuild';
await build({ entryPoints: ['src/server/index.ts'], outfile: 'dist/server.js', bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', sourcemap: true });
await build({ entryPoints: ['src/worker/entry.ts'], outfile: 'dist/worker.js', bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', sourcemap: true });
