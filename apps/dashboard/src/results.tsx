import { useState } from 'react';
import { get, isDemo } from './api';
import { fmt, fmtMs, Provenance, Stat } from './charts';
import { loadBaseline, meanSecondsPerTask, meanTokensPerTask, savingText, secondsSaved, tokensSaved, totalTokens, verification } from './metrics';
import { Badge, Empty, Loading, Page, useLoad } from './ui';
import { currentProject } from './api';

/** One plain file an outside evaluator can read, hash and re-check. It holds counts, decisions and receipts, and no code, prompt or path. */
async function exportEvidence(state: any, a: any): Promise<void> {
  const body = {
    format: 'agentontrack.evidence/v1',
    generatedAt: new Date().toISOString(),
    note: 'Self-reported by one installation. Nothing in it has been checked by anyone else.',
    goal: state.goal ? { statement: state.goal.statement, version: state.goal.version, status: state.goal.status } : null,
    tasks: state.tasks.map((t: any) => ({ id: t.id, title: t.title, status: t.evaluation.status, criteria: t.evaluation.criteria })),
    receipts: state.receipts.map((r: any) => ({ seq: r.seq, ts: r.ts, taskId: r.taskId, criterionId: r.criterionId, passed: r.passed, source: r.source })),
    integrity: { ok: state.integrity.ok, events: state.integrity.chain.events, witnessed: state.integrity.witnessEntries, signedCheckpoints: state.integrity.signedCheckpoints },
    usage: { sessions: a.totals.sessions, input: a.totals.input, output: a.totals.output, cacheRead: a.totals.cacheRead, cacheCreate: a.totals.cacheCreate, costUsd: a.totals.costUsd, providerReported: a.totals.providerReported },
    safety: a.safety,
    time: a.time,
    howToCheck: 'Run: agentontrack audit. It re-reads the log and the witness file and reports any break. The log itself stays on the machine that made it.',
  };
  const text = JSON.stringify(body, null, 2);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const url = URL.createObjectURL(new Blob([JSON.stringify({ ...body, sha256OfThisFileWithoutThisField: digest }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'agentontrack-evidence.json'; link.click();
  URL.revokeObjectURL(url);
}

const Row = ({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) => (
  <tr><th scope="row">{label}</th><td>{children}</td><td className="muted small">{note}</td></tr>
);

export function Results({ tick }: { tick: number }) {
  const st = useLoad<any>(() => get('/api/state'), [tick]);
  const an = useLoad<any>(() => get('/api/analytics'), [tick]);
  const ev = useLoad<any>(() => get('/api/evaluations'), []);
  const [msg, setMsg] = useState('');
  if (!st.data || !an.data) return <Loading error={st.error || an.error} />;
  const s = st.data; const a = an.data;
  const v = verification(s);
  const verified = s.tasks.filter((t: any) => t.evaluation.status === 'VERIFIED');
  const baseline = loadBaseline(currentProject());
  const tok = tokensSaved(a, baseline); const sec = secondsSaved(a, baseline);
  const meanT = meanTokensPerTask(a); const meanS = meanSecondsPerTask(a);
  const sf = a.safety;
  const held = ev.data?.heldout?.results?.['C agentontrack full'];

  return (
    <Page title="Results and evidence" intro="What was actually completed and checked in this project, what it cost, and what is not known. Every figure says where it came from." actions={<button className="btn primary" disabled={isDemo()} onClick={() => { setMsg(''); exportEvidence(s, a).catch((e) => setMsg(e.message)); }} data-testid="export-evidence">Export evidence receipts</button>}>
      {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
      {isDemo() ? <div className="alert warn" role="note">These are invented demo values. Nothing here can be exported from the demo.</div> : null}

      <section className="stats wide" aria-label="At a glance" data-testid="results-glance">
        <Stat label="Tasks verified by your own checks" value={`${v.tasksVerified} of ${v.tasksTotal}`} kind="record" sub="VERIFIED means every check passes on the current code." />
        <Stat label="Criteria currently passing" value={v.criteriaRate === null ? 'Unavailable' : `${Math.round(v.criteriaRate * 100)}%`} kind={v.criteriaRate === null ? 'unavailable' : 'record'} sub={v.criteriaRate === null ? 'No acceptance criteria yet.' : `${v.criteriaPassed} of ${v.criteriaTotal}`} />
        <Stat label="Verification runs that passed" value={v.runsRate === null ? 'Unavailable' : `${Math.round(v.runsRate * 100)}%`} kind={v.runsRate === null ? 'unavailable' : 'record'} sub={v.runsRate === null ? 'No verification has run.' : `${v.runsPassed} of ${v.runsTotal}`} />
        <Stat label="Unauthorized actions stopped" value={fmt(sf.deny + sf.requestApproval)} kind="record" sub={`${sf.detectedAfter} more caught afterwards. Missed: Unavailable, a miss leaves no record.`} />
      </section>

      <section className="card stack">
        <h2>Goals completed and verified</h2>
        {verified.length === 0 ? <Empty>No task is verified yet. A task becomes VERIFIED when AgentOnTrack runs your checks on the current code and they pass.</Empty>
          : <ul className="list" data-testid="verified-list">{verified.map((t: any) => <li key={t.id}><b>{t.title}</b> <Badge value="VERIFIED" /> <span className="muted small">{t.evaluation.progress.passed} of {t.evaluation.progress.total} checks, each with a receipt</span></li>)}</ul>}
        <p className="muted small">Goal: {s.goal ? `${s.goal.statement} (version ${s.goal.version}, ${s.goal.status})` : 'none set'}.</p>
      </section>

      <section className="card stack">
        <h2>Cost and time, as recorded</h2>
        <div className="table-wrap" tabIndex={0}><table>
          <thead><tr><th scope="col">Figure</th><th scope="col">Value</th><th scope="col">Source</th></tr></thead>
          <tbody>
            <Row label="Input and output tokens" note={a.totals.sessions ? undefined : 'No usage recorded for this project.'}>{a.totals.sessions ? <>{fmt(totalTokens(a))} <Provenance kind={a.totals.providerReported ? 'actual' : 'transcript'} /></> : 'Unavailable'}</Row>
            <Row label="List-price cost" note="List price, not what you pay on a subscription.">{a.totals.costUsd === null ? 'Unavailable' : `$${a.totals.costUsd.toFixed(4)}`}</Row>
            <Row label="Time in runs started here" note="Measured only for runs started from AgentOnTrack.">{a.time.runs ? fmtMs(a.time.runWallClockMs) : 'Unavailable'}</Row>
            <Row label="Mean tokens per task">{meanT.value === null ? 'Unavailable' : Math.round(meanT.value).toLocaleString('en')}</Row>
            <Row label="Mean seconds per task">{meanS.value === null ? 'Unavailable' : Math.round(meanS.value).toLocaleString('en')}</Row>
            <Row label="Tokens saved" note="Only against a baseline you typed in. Not a controlled experiment.">{tok.value === null ? <>Unavailable. {tok.why}</> : savingText(tok.value, 'tokens')}</Row>
            <Row label="Time saved" note="Same limit.">{sec.value === null ? <>Unavailable. {sec.why}</> : savingText(sec.value, 'seconds')}</Row>
            <Row label="Water and energy" note="Needs your own factors. Vendors publish no per-request figure.">Unavailable</Row>
          </tbody>
        </table></div>
        <p className="muted small">In AgentOnTrack&apos;s own matched benchmarks it used more tokens and time than the agent alone. Those averages are never used to claim a saving here.</p>
      </section>

      <section className="card stack">
        <h2>Safety: prevented, held and missed</h2>
        <dl className="kv">
          <dt>Never ran</dt><dd>{sf.deny} denied</dd>
          <dt>Held for you</dt><dd>{sf.requestApproval} waited for approval</dd>
          <dt>Caught afterwards</dt><dd>{sf.detectedAfter}, of which {sf.reverted} reversed</dd>
          <dt>Missed</dt><dd>Unavailable. A miss leaves no record to count.</dd>
        </dl>
        {held ? <p className="small" data-testid="results-benchmark">On {ev.data.heldout.scenarios} fixed scenarios with no model in the loop, {held.prevented} of {held.unauthorized} unauthorized actions were prevented, {held.detectedAfter} detected afterwards and {held.missed} missed, with {held.falseBlocks} false blocks. Self-authored and self-run.</p> : null}
      </section>

      <section className="card stack">
        <h2>Method, and what it does not show</h2>
        <ul className="small">
          <li>Receipts come from checks AgentOnTrack ran itself, on the current code. What an agent says it did is listed separately and counts as no evidence.</li>
          <li>The record is tamper-evident under stated assumptions, not immutable. Record integrity now: <Badge value={s.integrity.ok ? 'pass' : 'fail'} /> {s.integrity.chain.events} events.</li>
          <li>Everything here is self-reported by this installation. No outside party has checked it.</li>
        </ul>
      </section>

      <section className="card stack" data-testid="external-records">
        <h2>Outside evaluation and adoption</h2>
        <p><b>None recorded.</b> No independent evaluator has reproduced these results, and no adoption figure exists to show. An evaluator can read <code>docs/evaluation/INDEPENDENT.md</code>, export the receipts above, and re-run the checks on their own machine. Their statement belongs to them, and is added here only with their name and permission.</p>
        <p className="muted small">Feedback you send is optional and stays on this computer unless you turn on an account and choose to send it.</p>
      </section>
    </Page>
  );
}
