import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({ plugins: [react(), tailwindcss()], resolve: { alias: { '@port/shared': fileURLToPath(new URL('./src/port-shared', import.meta.url)), '@builder/shared': fileURLToPath(new URL('./src/shared', import.meta.url)), '@builder/components': fileURLToPath(new URL('./src/components', import.meta.url)) } }, build: { outDir: 'dist/web' } });
