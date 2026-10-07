import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/web/**/*.test.{ts,tsx}'], environment: 'happy-dom', maxWorkers: 2 } });
