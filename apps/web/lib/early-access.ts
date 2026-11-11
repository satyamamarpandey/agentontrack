// The early-access application: what is asked, what counts as valid, and how an application is identified.
// The same limits live in firestore.rules (validApplication), which is what actually decides what can be stored.

export const OS_OPTIONS = [
  ['windows', 'Windows'], ['macos', 'macOS'], ['linux', 'Linux'], ['other', 'Other'],
] as const;
export const TOOL_OPTIONS = [
  ['claude-code', 'Claude Code'], ['codex', 'OpenAI Codex'], ['hermes', 'Hermes Agent'], ['local-models', 'Local AI models'], ['other', 'Other agentic AI tools'], ['none', 'None yet / exploring'],
] as const;
export const USE_OPTIONS = [
  ['multi-agent', 'Managing several AI agents'], ['monitoring', 'Monitoring agent executions'], ['governance', 'Agent safety and governance'], ['approvals', 'Human approval workflows'],
  ['sandbox', 'Sandbox testing'], ['automation', 'Agent automation'], ['local', 'Local AI development'], ['team', 'Team collaboration'], ['other', 'Other'],
] as const;
export const FREQUENCY_OPTIONS = [
  ['daily', 'Every day'], ['weekly', 'A few times a week'], ['monthly', 'A few times a month'], ['rarely', 'Rarely'], ['never', 'Not yet'],
] as const;

export type Os = (typeof OS_OPTIONS)[number][0];
export type Tool = (typeof TOOL_OPTIONS)[number][0];
export type UseCase = (typeof USE_OPTIONS)[number][0];
export type Frequency = (typeof FREQUENCY_OPTIONS)[number][0];

export const LIMITS = { name: 120, email: 254, organization: 120, role: 120, other: 120, note: 600, challenge: 1000, why: 1000 } as const;

/** What the person types. Everything is a string or a list of strings until cleanApplication has looked at it. */
export interface ApplicationInput {
  name: string; email: string; organization: string; role: string;
  os: string[]; osOther: string;
  tools: string[]; toolsOther: string;
  useCases: string[]; useCasesNote: string;
  frequency: string; challenge: string; why: string;
  privacyAccepted: boolean; marketingConsent: boolean;
}

/** What is stored. `status`, `createdAt` and `schema` are added on the way out; the id is the hash of the email. */
export interface Application {
  name: string; email: string; organization?: string; role?: string;
  os: Os[]; osOther?: string;
  tools: Tool[]; toolsOther?: string;
  useCases: UseCase[]; useCasesNote?: string;
  frequency: Frequency; challenge?: string; why?: string;
  privacyAccepted: true; marketingConsent: boolean;
  source: 'popup' | 'page';
}

export type FieldErrors = Partial<Record<keyof ApplicationInput, string>>;
export class InvalidApplication extends Error {
  constructor(readonly fields: FieldErrors) { super('Please check the highlighted fields.'); }
}

export const EMPTY_INPUT: ApplicationInput = { name: '', email: '', organization: '', role: '', os: [], osOther: '', tools: [], toolsOther: '', useCases: [], useCasesNote: '', frequency: '', challenge: '', why: '', privacyAccepted: false, marketingConsent: false };

// One @, something on each side, a dot in the domain, no spaces. Deliberately simple: the address is confirmed when the person signs in with it later.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Validates one step (so the form can stop the person early) or the whole application. Returns the clean record or throws InvalidApplication. */
export function cleanApplication(input: ApplicationInput, source: Application['source'], step: 1 | 2 | 3 | 'all' = 'all'): Application {
  const errors: FieldErrors = {};
  const t = (s: string) => s.trim();
  const over = (s: string, max: number) => t(s).length > max;
  if (step === 1 || step === 'all') {
    if (!t(input.name)) errors.name = 'Enter your name.'; else if (over(input.name, LIMITS.name)) errors.name = `Keep it under ${LIMITS.name} characters.`;
    const email = normalizeEmail(input.email);
    if (!email) errors.email = 'Enter your email address.'; else if (!EMAIL.test(email) || email.length > LIMITS.email) errors.email = 'That does not look like an email address.';
    if (over(input.organization, LIMITS.organization)) errors.organization = `Keep it under ${LIMITS.organization} characters.`;
    if (over(input.role, LIMITS.role)) errors.role = `Keep it under ${LIMITS.role} characters.`;
  }
  if (step === 2 || step === 'all') {
    if (!input.os.length) errors.os = 'Choose at least one operating system.';
    if (input.os.some((o) => !OS_OPTIONS.some(([id]) => id === o))) errors.os = 'Choose from the options listed.';
    if (input.os.includes('other') && over(input.osOther, LIMITS.other)) errors.osOther = `Keep it under ${LIMITS.other} characters.`;
    if (!input.tools.length) errors.tools = 'Choose at least one, or "None yet".';
    if (input.tools.some((o) => !TOOL_OPTIONS.some(([id]) => id === o))) errors.tools = 'Choose from the options listed.';
    if (input.tools.includes('other') && !t(input.toolsOther)) errors.toolsOther = 'Name the other tools.';
    if (over(input.toolsOther, LIMITS.other)) errors.toolsOther = `Keep it under ${LIMITS.other} characters.`;
    if (!FREQUENCY_OPTIONS.some(([id]) => id === input.frequency)) errors.frequency = 'Choose how often you use AI coding agents.';
  }
  if (step === 3 || step === 'all') {
    if (!input.useCases.length) errors.useCases = 'Choose at least one.';
    if (input.useCases.some((o) => !USE_OPTIONS.some(([id]) => id === o))) errors.useCases = 'Choose from the options listed.';
    if (over(input.useCasesNote, LIMITS.note)) errors.useCasesNote = `Keep it under ${LIMITS.note} characters.`;
    if (over(input.challenge, LIMITS.challenge)) errors.challenge = `Keep it under ${LIMITS.challenge} characters.`;
    if (over(input.why, LIMITS.why)) errors.why = `Keep it under ${LIMITS.why} characters.`;
    if (!input.privacyAccepted) errors.privacyAccepted = 'Please read the privacy notice and tick the box to apply.';
  }
  if (Object.keys(errors).length) throw new InvalidApplication(errors);
  const has = (s: string) => t(s).length > 0;
  const app: Application = {
    name: t(input.name), email: normalizeEmail(input.email),
    os: [...new Set(input.os)] as Os[], tools: [...new Set(input.tools)] as Tool[], useCases: [...new Set(input.useCases)] as UseCase[],
    frequency: input.frequency as Frequency, privacyAccepted: true, marketingConsent: !!input.marketingConsent, source,
  };
  if (has(input.organization)) app.organization = t(input.organization);
  if (has(input.role)) app.role = t(input.role);
  if (app.os.includes('other') && has(input.osOther)) app.osOther = t(input.osOther);
  if (app.tools.includes('other') && has(input.toolsOther)) app.toolsOther = t(input.toolsOther);
  if (has(input.useCasesNote)) app.useCasesNote = t(input.useCasesNote);
  if (has(input.challenge)) app.challenge = t(input.challenge);
  if (has(input.why)) app.why = t(input.why);
  return app;
}

/** The document id: the SHA-256 of the lower-cased email, as hex. One application per address, enforced by the rules, with no list of addresses anywhere. */
export async function applicationId(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeEmail(email));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A short reference a person can quote: AOT- and the first six hex characters of the id. */
export const shortReference = (id: string) => `AOT-${id.slice(0, 6).toUpperCase()}`;

/** Labels for the stored values, for the admin table and the confirmation. */
export const labelOf = (options: readonly (readonly [string, string])[], id: string) => options.find(([k]) => k === id)?.[1] ?? id;

/**
 * One cell of the administrator's CSV export. Applicants type the names, organisations and roles, and a spreadsheet opening the file would run a
 * cell that starts with =, +, - or @ as a formula (one that can send the other rows to a web address). Such a cell gets a leading apostrophe,
 * which spreadsheets read as "text"; quotes are doubled; tabs and line breaks become spaces.
 */
export function csvCell(v: unknown): string {
  const s = String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  const safe = /^\s*[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/* ---- Browser-side remembering, so the popup is not a nag. ---- */
export const SEEN_KEY = 'aot-ea-seen';        // sessionStorage: shown or dismissed once this session
export const APPLIED_KEY = 'aot-ea-applied';  // localStorage: the reference of a sent application
export const POPUP_DELAY_MS = 5000;

export function rememberSeen(): void { try { sessionStorage.setItem(SEEN_KEY, '1'); } catch { /* storage may be blocked */ } }
export function wasSeen(): boolean { try { return sessionStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } }
export function rememberApplied(reference: string): void { try { localStorage.setItem(APPLIED_KEY, reference); } catch { /* storage may be blocked */ } }
export function appliedBefore(): string | null { try { return localStorage.getItem(APPLIED_KEY); } catch { return null; } }
