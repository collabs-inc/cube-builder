import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ resolve: { alias: { '@port/shared': fileURLToPath(new URL('./src/port-shared', import.meta.url)), '@builder/components': fileURLToPath(new URL('./src/components', import.meta.url)) } }, test: { include: ['src/renderer/**/*.test.{ts,tsx}'], environment: 'node', maxWorkers: 2 } });
