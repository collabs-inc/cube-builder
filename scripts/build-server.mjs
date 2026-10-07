import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { repairPtyHelpers } from '../src/shared/pty-helper.mjs';
import { build } from 'esbuild';
await repairPtyHelpers(dirname(createRequire(import.meta.url).resolve('node-pty/package.json')));
await build({ entryPoints: ['src/server/index.ts'], outfile: 'dist/server.js', bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', sourcemap: true });
await build({ entryPoints: ['src/worker/entry.ts'], outfile: 'dist/worker.js', bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', sourcemap: true });
