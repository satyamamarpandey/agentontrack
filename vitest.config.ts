import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));
export default defineConfig({
  resolve: { alias: { '@agentontrack/core': src('core'), '@agentontrack/adapters': src('adapters'), '@agentontrack/mcp-server': src('mcp-server'), '@agentontrack/companion': src('companion') } },
  test: { include: ['packages/*/test/**/*.test.ts', 'apps/dashboard/test/**/*.test.ts', 'apps/web/test/**/*.test.ts', 'benchmarks/**/*.test.ts'], testTimeout: 30000, env: { AGENTONTRACK_ENV_FILE: 'none' } },
});
