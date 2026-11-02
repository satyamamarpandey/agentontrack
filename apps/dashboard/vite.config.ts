import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Firebase's hosts appear in the page's policy only in a build that has accounts. Without a config, the page may reach nothing of Google's. */
const FIREBASE_HOSTS = ' https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firebaseinstallations.googleapis.com';
const csp = (): Plugin => ({ name: 'aot-csp', transformIndexHtml: (html) => html.replace('%FIREBASE_HOSTS%', process.env.VITE_FIREBASE_CONFIG ? FIREBASE_HOSTS : '') });

export default defineConfig({ base: process.env.VITE_BASE ?? '/', plugins: [react(), csp()], server: { fs: { allow: ['../..'] } }, build: { outDir: process.env.VITE_OUT ?? '../../packages/companion/ui', emptyOutDir: true } });
