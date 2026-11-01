import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ base: process.env.VITE_BASE ?? '/', plugins: [react()], server: { fs: { allow: ['../..'] } }, build: { outDir: process.env.VITE_OUT ?? '../../packages/companion/ui', emptyOutDir: true } });
