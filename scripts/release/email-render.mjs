// Renders the AgentOnTrack verification email (HTML and plain text) from the templates beside this file. Pure: no network, no clock, no logging.
// Values are escaped for HTML; the action link must be https, on an allowed host, and carry an action code. The link is never logged by anything here.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'email-templates');
export const SUBJECT = 'Verify your email for AgentOnTrack';
/** Hosts an action link may point at: Firebase's own handler for this project, or the product's own site. */
export const ALLOWED_HOSTS = (project) => [`${project}.firebaseapp.com`, `${project}.web.app`, 'pandeysatyam.com'];

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Returns the link as a normalized string, or throws. The message never includes the link. */
export function validateActionUrl(raw, project) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('The action link is not a URL'); }
  if (u.protocol !== 'https:') throw new Error('The action link must use https');
  if (!ALLOWED_HOSTS(project).includes(u.hostname)) throw new Error('The action link points at a host that is not allowed');
  if (!u.searchParams.get('oobCode')) throw new Error('The action link carries no action code');
  return u.toString();
}

/** A display name is shown only as text: control characters are removed and it is cut short. An empty name becomes "there". */
export function cleanName(name) {
  const n = [...String(name ?? '')].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || ch === '<' || ch === '>' ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim().slice(0, 60);
  return n || 'there';
}

export function renderVerification({ displayName, verifyUrl, project }) {
  const url = validateActionUrl(verifyUrl, project);
  const name = cleanName(displayName);
  const fill = (tpl, esc) => tpl.replaceAll('{{DISPLAY_NAME}}', esc(name)).replaceAll('{{VERIFY_URL}}', esc(url));
  const html = fill(readFileSync(join(DIR, 'verification_email.html'), 'utf8'), escapeHtml);
  const text = fill(readFileSync(join(DIR, 'verification_email.txt'), 'utf8'), (s) => s);
  return { subject: SUBJECT, html, text };
}
