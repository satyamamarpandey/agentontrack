import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { renderVerification, validateActionUrl, cleanName, SUBJECT } from '../../../scripts/release/email-render.mjs';

const P = 'agentontrack-early-access';
const LINK = `https://${P}.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=ABC123&apiKey=k`;

describe('branded verification email', () => {
  it('renders HTML and plain text with the same link, and a product subject', () => {
    const r = renderVerification({ displayName: 'Ada', verifyUrl: LINK, project: P });
    expect(r.subject).toBe(SUBJECT);
    expect(r.subject).not.toMatch(/project-|%APP_NAME%/);
    expect(r.html).toContain('Hello Ada,');
    expect(r.text).toContain('Hello Ada,');
    expect(r.html).toContain('oobCode=ABC123');
    expect(r.text).toContain(LINK);
    expect(r.html + r.text).not.toMatch(/\{\{|<img|pixel|tracking/i);
  });
  it('escapes the name and the link for HTML', () => {
    const r = renderVerification({ displayName: '<script>alert(1)</script>"x', verifyUrl: LINK, project: P });
    expect(r.html).not.toContain('<script>');
    expect(cleanName('A\u0000B\n<C>')).toBe('A B C');
    expect(cleanName('')).toBe('there');
    expect(r.html).toContain('mode=verifyEmail&amp;oobCode=ABC123');
  });
  it('refuses http, foreign hosts, a missing code and junk, without echoing the link', () => {
    for (const bad of [LINK.replace('https', 'http'), 'https://evil.example/__/auth/action?oobCode=1', `https://${P}.firebaseapp.com/x`, 'nonsense', `https://${P}.firebaseapp.com.evil.example/a?oobCode=1`]) {
      let msg = '';
      try { validateActionUrl(bad, P); } catch (e) { msg = (e as Error).message; }
      expect(msg).not.toBe('');
      expect(msg).not.toContain('oobCode=');
    }
  });
});
