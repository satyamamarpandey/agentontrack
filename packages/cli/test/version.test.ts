import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/self.js';

// A release once shipped a VS Code extension whose manifest still said rc.3 while everything else said rc.5.
describe('version consistency', () => {
  it('the VS Code extension has the same version as the program', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../vscode/package.json', import.meta.url), 'utf8'));
    expect(pkg.version).toBe(VERSION);
  });
});
