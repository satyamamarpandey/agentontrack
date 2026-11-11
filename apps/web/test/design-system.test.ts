import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const block = (css: string) => { const a = css.indexOf('/* tokens:start */'); const b = css.indexOf('/* tokens:end */'); expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a); return css.slice(a, b); };

describe('one design system for the site and the dashboard', () => {
  const site = read('apps/web/app/globals.css');
  const dash = read('apps/dashboard/src/styles.css');
  it('shares the token block byte for byte', () => {
    expect(block(site)).toBe(block(dash));
  });
  it('defines both themes, the three type families and the motion tokens', () => {
    const t = block(site);
    for (const v of ["[data-theme='light']", '--font-ui', '--font-display', '--font-mono', '--dur-1', '--ease', '--accent', '--good', '--warn', '--bad', '--scrim']) expect(t).toContain(v);
  });
  it('moves only when the person allows it', () => {
    for (const css of [site, dash]) {
      const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'));
      expect(motion).toContain('@keyframes');
      // No animation or transition is declared outside that query, apart from the scroll-linked reveal, which sits in its own no-preference query.
      const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\)[\s\S]*?\n}\n/g, '').replace(/@supports \(animation-timeline: view\(\)\)[\s\S]*?\n}\n/g, '');
      expect(outside).not.toMatch(/\banimation:/);
      expect(outside).not.toMatch(/\btransition:/);
    }
  });
  it('bundles its fonts, with their licences, in both apps', () => {
    for (const dir of ['apps/web/app/fonts/', 'apps/dashboard/public/fonts/']) {
      for (const f of ['inter.woff2', 'jetbrains-mono.woff2', 'LICENSES.txt']) expect(existsSync(new URL(dir + f, root)), dir + f).toBe(true);
      const lic = read(dir + 'LICENSES.txt');
      expect(lic).toContain('SIL Open Font License');
      expect(lic).toContain('Inter');
      expect(lic).toContain('JetBrains Mono');
    }
    // The site lets Next declare Inter (preloaded, metrics-matched fallback) from the same bundled file; the dashboard declares it in CSS.
    const layout = read('apps/web/app/layout.tsx');
    expect(layout).toMatch(/localFont\(\{ src: '\.\/fonts\/inter\.woff2'/);
    expect(layout).toContain("variable: '--font-inter'");
    expect(block(site)).toContain("var(--font-inter, 'Inter')");
    expect(site).not.toContain('url(./fonts/inter.woff2)'); // one declaration, not two
    expect(dash).toContain("url(/fonts/inter.woff2)");
    // The dashboard page preloads the UI font and allows fonts only from itself.
    const html = read('apps/dashboard/index.html');
    expect(html).toContain('rel="preload" href="/fonts/inter.woff2" as="font"');
    expect(html).toContain("font-src 'self'");
  });
});
