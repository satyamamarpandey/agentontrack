// One CommonJS file for the extension host. Nothing from vscode is bundled, and nothing from the network is fetched at run time.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: 'dist/extension.js', external: ['vscode'], sourcemap: false, minify: false, legalComments: 'none', logLevel: 'warning' });
mkdirSync('media', { recursive: true });
if (!existsSync('media/icon.svg')) writeFileSync('media/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h10M4 12h16M4 18h7"/><circle cx="19" cy="6" r="2" fill="currentColor"/><circle cx="15" cy="18" r="2" fill="currentColor"/></svg>\n');
copyFileSync('../../LICENSE', 'LICENSE');
console.log('built dist/extension.js');
