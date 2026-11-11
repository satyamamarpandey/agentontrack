'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from '../link';
import { Icon } from '../ui/icons';
import { ACCOUNTS_ENABLED, loadAccounts } from '../../lib/accounts-config';
import { appliedBefore, cleanApplication, EMPTY_INPUT, FREQUENCY_OPTIONS, InvalidApplication, LIMITS, OS_OPTIONS, rememberApplied, TOOL_OPTIONS, USE_OPTIONS, type ApplicationInput, type FieldErrors } from '../../lib/early-access';

const DRAFT = 'aot-ea-draft';
const STEPS = ['About you', 'Your setup', 'Your goals'] as const;
const LIVE_SITE = 'https://pandeysatyam.com/agentontrack/';

function readDraft(): ApplicationInput {
  try { const raw = sessionStorage.getItem(DRAFT); if (raw) return { ...EMPTY_INPUT, ...JSON.parse(raw) }; } catch { /* no draft */ }
  return EMPTY_INPUT;
}

function Field({ id, label, error, hint, children, optional }: { id: string; label: string; error?: string; hint?: string; children: ReactNode; optional?: boolean }) {
  return (
    <div className="stack" data-field={id}>
      <label htmlFor={id}>{label}{optional ? <span className="hint"> (optional)</span> : null}</label>
      {children}
      {hint && !error ? <span className="hint" id={`${id}-hint`}>{hint}</span> : null}
      {error ? <span className="field-error" id={`${id}-error`} role="alert"><Icon name="alert" size={15} />{error}</span> : null}
    </div>
  );
}

function Choices({ name, options, value, onChange, error, legend, note }: { name: string; options: readonly (readonly [string, string])[]; value: string[]; onChange: (v: string[]) => void; error?: string; legend: string; note?: string }) {
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter((v) => v !== id));
  return (
    <fieldset aria-describedby={error ? `${name}-error` : undefined} aria-invalid={error ? 'true' : undefined} data-field={name}>
      <legend>{legend}{note ? <small>{note}</small> : null}</legend>
      <div className="choices">
        {options.map(([id, label]) => (
          <label key={id} className="choice"><input type="checkbox" name={name} value={id} checked={value.includes(id)} onChange={(e) => toggle(id, e.target.checked)} />{label}</label>
        ))}
      </div>
      {error ? <span className="field-error" id={`${name}-error`} role="alert"><Icon name="alert" size={15} />{error}</span> : null}
    </fieldset>
  );
}

/**
 * The application, in three short steps. Each step is checked before the next opens, the whole thing is checked again before it is sent, and the
 * rules in Firestore check it a third time. A draft lives in this tab only, so closing the dialog by accident loses nothing.
 */
export function EarlyAccessForm({ source, onDone, heading = true }: { source: 'popup' | 'page'; onDone?: (reference: string) => void; heading?: boolean }) {
  const [input, setInput] = useState<ApplicationInput>(EMPTY_INPUT);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [earlier, setEarlier] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { setInput(readDraft()); setEarlier(appliedBefore()); }, []);
  useEffect(() => { try { sessionStorage.setItem(DRAFT, JSON.stringify(input)); } catch { /* storage may be blocked */ } }, [input]);

  const set = <K extends keyof ApplicationInput>(k: K, v: ApplicationInput[K]) => { setInput((i) => ({ ...i, [k]: v })); setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e)); };
  const focusFirstError = (fields: FieldErrors) => {
    const first = Object.keys(fields).find((k) => fields[k as keyof FieldErrors]);
    if (!first) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-field="${first}"] input, [data-field="${first}"] textarea, [data-field="${first}"] select`);
    el?.focus();
  };
  const check = (s: 1 | 2 | 3) => {
    try { cleanApplication(input, source, s); setErrors({}); return true; }
    catch (e) { if (e instanceof InvalidApplication) { setErrors(e.fields); focusFirstError(e.fields); return false; } throw e; }
  };
  const next = () => { if (check(step)) { setStep((s) => (s + 1) as 1 | 2 | 3); box.current?.querySelector<HTMLElement>('h3, legend, label')?.focus?.(); } };
  const submit = async () => {
    setFail('');
    let app;
    try { app = cleanApplication(input, source, 'all'); setErrors({}); }
    catch (e) { if (e instanceof InvalidApplication) { setErrors(e.fields); const firstStep = e.fields.name || e.fields.email || e.fields.organization || e.fields.role ? 1 : e.fields.os || e.fields.osOther || e.fields.tools || e.fields.toolsOther || e.fields.frequency ? 2 : 3; setStep(firstStep); setTimeout(() => focusFirstError(e.fields), 0); return; } throw e; }
    if (!loadAccounts) { setFail(`This copy of the site cannot receive applications. Apply on the live site: ${LIVE_SITE}`); return; }
    setBusy(true);
    try {
      const a = await loadAccounts();
      const r = await a.submitApplication(app);
      rememberApplied(r.reference);
      try { sessionStorage.removeItem(DRAFT); } catch { /* fine */ }
      setSent(r.reference);
      onDone?.(r.reference);
    } catch (e) { setFail((e as Error).message || 'That did not work. Try again in a moment.'); }
    finally { setBusy(false); }
  };

  if (sent) {
    return (
      <div className="stack" data-testid="early-access-sent" ref={box}>
        <p className="badge accent" style={{ alignSelf: 'flex-start' }}><Icon name="check" size={14} />Application received</p>
        <h2>Thank you. You are on the list.</h2>
        <p>Your reference is <code data-testid="application-reference">{sent}</code>. Places are given by hand, in small groups, so this may take a little while.</p>
        <h4>What happens next</h4>
        <ol>
          <li>We read every application and pick a balanced group across operating systems and agents.</li>
          <li>If you are chosen, you receive a personal invitation link by email from the maintainer. It works once, for your address only, and expires.</li>
          <li>With it you create your account, install the desktop preview, and connect your own agents on your own machine.</li>
        </ol>
        <p className="small muted">Nothing is sent to you unless you are invited{input.marketingConsent ? ', apart from the occasional update you asked for' : ''}. To withdraw, sign in later with this address or write to the maintainer through the <Link href="/feedback">feedback page</Link>.</p>
      </div>
    );
  }

  if (earlier && !fail) {
    return (
      <div className="stack" data-testid="early-access-earlier" ref={box}>
        <h2>We already have your application</h2>
        <p>Reference <code>{earlier}</code>. There is nothing more to do: if you are chosen, the invitation arrives by email. Applied from another address? <button type="button" className="link" onClick={() => setEarlier(null)}>Apply again</button>.</p>
      </div>
    );
  }

  const err = (k: keyof FieldErrors) => errors[k];
  const aria = (k: keyof FieldErrors) => ({ 'aria-invalid': err(k) ? ('true' as const) : undefined, 'aria-describedby': err(k) ? `${k}-error` : undefined });

  return (
    <div className="stack" ref={box} data-testid="early-access-form">
      {heading ? <>
        <p className="eyebrow">Early access</p>
        <h2 id="ea-title">Get early access to AgentOnTrack</h2>
        <p className="muted">Help shape how AgentOnTrack works. Apply for early access and test it before it opens to everyone. Places are limited and chosen by hand; we read every application.</p>
      </> : null}
      <ol className="stepper" aria-label="Steps">
        {STEPS.map((s, i) => <li key={s} data-state={i + 1 < step ? 'done' : i + 1 === step ? 'current' : 'todo'} aria-current={i + 1 === step ? 'step' : undefined}><span>{i + 1}. {s}</span></li>)}
      </ol>
      <form className="form" style={{ maxWidth: 'none', marginTop: 4 }} noValidate onSubmit={(e) => { e.preventDefault(); if (step < 3) next(); else void submit(); }}>
        {step === 1 ? (
          <div className="stack" style={{ gap: 14 }}>
            <h3 tabIndex={-1} style={{ outline: 'none' }}>About you</h3>
            <Field id="name" label="Full name" error={err('name')}><input id="name" name="name" value={input.name} onChange={(e) => set('name', e.target.value)} autoComplete="name" maxLength={LIMITS.name} required data-autofocus {...aria('name')} /></Field>
            <Field id="email" label="Email address" error={err('email')} hint="The invitation goes to this address, and only this address can use it."><input id="email" name="email" type="email" value={input.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" inputMode="email" maxLength={LIMITS.email} required {...aria('email')} /></Field>
            <div className="two">
              <Field id="organization" label="Organization or company" optional error={err('organization')}><input id="organization" name="organization" value={input.organization} onChange={(e) => set('organization', e.target.value)} autoComplete="organization" maxLength={LIMITS.organization} {...aria('organization')} /></Field>
              <Field id="role" label="Role or primary occupation" optional error={err('role')}><input id="role" name="role" value={input.role} onChange={(e) => set('role', e.target.value)} autoComplete="organization-title" maxLength={LIMITS.role} {...aria('role')} /></Field>
            </div>
          </div>
        ) : null}
        {step === 2 ? (
          <div className="stack" style={{ gap: 18 }}>
            <h3 tabIndex={-1} style={{ outline: 'none' }}>Your setup</h3>
            <Choices name="os" legend="Which operating system do you primarily use for agentic AI development?" note="Choose every one you use." options={OS_OPTIONS} value={input.os} onChange={(v) => set('os', v)} error={err('os')} />
            {input.os.includes('other') ? <Field id="osOther" label="Which other operating system?" optional error={err('osOther')}><input id="osOther" name="osOther" value={input.osOther} onChange={(e) => set('osOther', e.target.value)} maxLength={LIMITS.other} {...aria('osOther')} /></Field> : null}
            <Choices name="tools" legend="Which agentic AI tools do you currently use?" note="Choose every one that applies." options={TOOL_OPTIONS} value={input.tools} onChange={(v) => set('tools', v)} error={err('tools')} />
            {input.tools.includes('other') ? <Field id="toolsOther" label="Which other tools?" error={err('toolsOther')}><input id="toolsOther" name="toolsOther" value={input.toolsOther} onChange={(e) => set('toolsOther', e.target.value)} maxLength={LIMITS.other} {...aria('toolsOther')} /></Field> : null}
            <Field id="frequency" label="How frequently do you use AI coding agents?" error={err('frequency')}>
              <select id="frequency" name="frequency" value={input.frequency} onChange={(e) => set('frequency', e.target.value)} required {...aria('frequency')}>
                <option value="">Choose one</option>
                {FREQUENCY_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </Field>
          </div>
        ) : null}
        {step === 3 ? (
          <div className="stack" style={{ gap: 18 }}>
            <h3 tabIndex={-1} style={{ outline: 'none' }}>Your goals</h3>
            <Choices name="useCases" legend="What would you like to use AgentOnTrack for?" note="Choose every one that applies." options={USE_OPTIONS} value={input.useCases} onChange={(v) => set('useCases', v)} error={err('useCases')} />
            <Field id="useCasesNote" label="Anything to add about that?" optional error={err('useCasesNote')}><textarea id="useCasesNote" name="useCasesNote" rows={2} value={input.useCasesNote} onChange={(e) => set('useCasesNote', e.target.value)} maxLength={LIMITS.note} {...aria('useCasesNote')} /></Field>
            <Field id="challenge" label="What is your biggest challenge when managing AI agents?" optional error={err('challenge')}><textarea id="challenge" name="challenge" rows={3} value={input.challenge} onChange={(e) => set('challenge', e.target.value)} maxLength={LIMITS.challenge} {...aria('challenge')} /></Field>
            <Field id="why" label="Why would you like early access?" optional error={err('why')}><textarea id="why" name="why" rows={3} value={input.why} onChange={(e) => set('why', e.target.value)} maxLength={LIMITS.why} {...aria('why')} /></Field>
            <div className="panel" style={{ margin: 0 }} data-field="privacyAccepted">
              <h4 style={{ marginTop: 0 }}>Privacy</h4>
              <p className="small">Your answers are stored in Firebase, a Google service, where only the maintainer can read them. They are used to choose and invite testers and to decide which connectors to build next, and for nothing else. They are not sold or shared. You can withdraw by signing in later with this address, or by asking through the <Link href="/feedback">feedback page</Link>. Full details: <Link href="/privacy">privacy</Link>.</p>
              <label className="check"><input type="checkbox" name="privacyAccepted" checked={input.privacyAccepted} onChange={(e) => set('privacyAccepted', e.target.checked)} {...aria('privacyAccepted')} /> I have read the privacy notice and I apply for early access.</label>
              {err('privacyAccepted') ? <span className="field-error" id="privacyAccepted-error" role="alert"><Icon name="alert" size={15} />{err('privacyAccepted')}</span> : null}
              <label className="check" style={{ marginTop: 8 }}><input type="checkbox" name="marketingConsent" checked={input.marketingConsent} onChange={(e) => set('marketingConsent', e.target.checked)} /> <span>Also send me occasional updates about AgentOnTrack by email. <span className="hint">Separate from the application; optional; you can stop any time.</span></span></label>
            </div>
          </div>
        ) : null}
        {fail ? <p className="alert bad" role="alert" data-testid="early-access-error">{fail}</p> : null}
        {!ACCOUNTS_ENABLED && step === 3 ? <p className="alert" role="note">This copy of the site has no backend, so it cannot store applications. The live site can.</p> : null}
        <div className="dialog-foot">
          <div>{step > 1 ? <button type="button" className="btn ghost" onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)} data-testid="ea-back"><Icon name="arrow-left" size={16} />Back</button> : null}</div>
          <div className="row" style={{ alignItems: 'center' }}>
            <span className="small muted">Step {step} of 3</span>
            {step < 3
              ? <button type="submit" className="btn primary" data-testid="ea-next">Continue<Icon name="arrow-right" size={16} data-nudge="" /></button>
              : <button type="submit" className="btn primary" disabled={busy} data-testid="ea-submit">{busy ? 'Sending…' : 'Send application'}</button>}
          </div>
        </div>
      </form>
    </div>
  );
}
