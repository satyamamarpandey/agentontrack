import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Firebase's hosts appear in the page's policy only in a build that has accounts. Without a config, the page may reach nothing of Google's. */
const FIREBASE_HOSTS = ' https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firebaseinstallations.googleapis.com';
/** App Check loads reCAPTCHA. Its hosts are allowed only in a build that has a key. */
const APPCHECK_CONNECT = ' https://firebaseappcheck.googleapis.com https://www.google.com';
const APPCHECK_SCRIPT = ' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/';
const APPCHECK_FRAME = ' https://www.google.com/recaptcha/ https://recaptcha.google.com';
const csp = (): Plugin => ({ name: 'aot-csp', transformIndexHtml: (html) => {
  const ac = !!(process.env.VITE_FIREBASE_CONFIG && process.env.VITE_APPCHECK_KEY);
  return html.replace('%FIREBASE_HOSTS%', (process.env.VITE_FIREBASE_CONFIG ? FIREBASE_HOSTS : '') + (ac ? APPCHECK_CONNECT : '')).replace('%APPCHECK_SCRIPT%', ac ? APPCHECK_SCRIPT : '').replace('%APPCHECK_FRAME%', ac ? APPCHECK_FRAME : '');
} });

export default defineConfig({ base: process.env.VITE_BASE ?? '/', plugins: [react(), csp()], server: { fs: { allow: ['../..'] } }, build: { outDir: process.env.VITE_OUT ?? '../../packages/companion/ui', emptyOutDir: true } });
