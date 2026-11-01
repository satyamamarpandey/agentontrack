import { Article } from '../content';
import { readResult } from '../../lib/results';

export const metadata = { title: 'Benchmarks' };

const num = (x: unknown, f: (n: number) => string | number) => (typeof x === 'number' && Number.isFinite(x) ? f(x) : 'Unavailable');
const NO_GATE = new Set(['A', 'A-doc', 'B']);

/** Renders v3 and v4 the same way. A field a result file lacks shows as Unavailable, never as a guess. */
function Matched({ m, testId }: { m: any; testId: string }) {
  return <>
    {Array.isArray(m.vsA) ? <><h3>Difference from the agent alone (95% bootstrap interval, paired by task)</h3><div className="table-wrap" tabIndex={0}><table><thead><tr><th scope="col">Condition</th><th scope="col">Tokens</th><th scope="col">Seconds</th></tr></thead><tbody>{m.vsA.map((v: any) => <tr key={v.condition}><th scope="row">{v.condition}</th><td>{num(v.tokensDiffCI95?.[0], Math.round)} to {num(v.tokensDiffCI95?.[1], Math.round)}</td><td>{num(v.wallSecondsDiffCI95?.[0], (n) => n.toFixed(1))} to {num(v.wallSecondsDiffCI95?.[1], (n) => n.toFixed(1))}</td></tr>)}</tbody></table></div></> : null}
    {Array.isArray(m.summary) ? <div className="table-wrap" tabIndex={0}><table data-testid={testId}>
      <thead><tr><th scope="col">Condition</th><th scope="col">Runs</th><th scope="col">Passed the check</th><th scope="col">Mean tokens (in + out)</th><th scope="col">Mean wall clock</th><th scope="col">Unauthorized effects</th><th scope="col">Block candidates</th><th scope="col">Wrongly VERIFIED</th></tr></thead>
      <tbody>{m.summary.map((c: any) => <tr key={c.condition}><th scope="row">{c.condition}</th><td>{num(c.runs, String)}</td><td>{num(c.passRate, (n) => `${Math.round(n * 100)}%`)}</td><td>{num(c.meanTokens, Math.round)} ± {num(c.sdTokens, Math.round)}</td><td>{num(c.meanWallSeconds, (n) => `${n.toFixed(1)} s`)}</td><td>{num(c.unauthorizedEffects, String)}</td><td>{NO_GATE.has(c.condition) ? 'n/a' : num(c.falseBlockCandidates, String)}</td><td>{NO_GATE.has(c.condition) ? 'n/a' : num(c.wrongVerified, String)}</td></tr>)}</tbody>
    </table></div> : <p>Unavailable</p>}
  </>;
}

export default function Benchmarks() {
  const held = readResult('heldout.json');
  const matched = readResult('matched-v3.json') ?? readResult('matched-v3.partial.json');
  const v4 = readResult('matched-v4.json');
  const live = readResult('live-claude-code.json');
  const runtimes = readResult('live-runtimes.json');
  const perf = readResult('performance.json');
  return (
    <Article title="Benchmarks" intro="Every number here comes from a recorded run in the repository. All were self-run. No independent evaluator has reproduced them yet. No savings are claimed, because none were measured.">
      <h2>Matched live benchmark v3</h2>
      {matched ? <>
        <p>{matched.limits}</p>
        <p><b>What this shows.</b> AgentOnTrack costs more, clearly: it used more tokens and took longer than the agent alone, and does not save either here. Telling the agent the goal explains the success gap: a plain goal in <code>CLAUDE.md</code> (A-doc) did as well as AgentOnTrack. Gating stopped the unauthorized effects, which written instructions did not, but native deny rules (B) also stopped them in this set, so no unique safety advantage is shown. A task can reach VERIFIED while unfinished if its check is weak. Strict mode blocks a lot.</p>
        <Matched m={matched} testId="matched-v3" />
      </> : <p>Unavailable</p>}

      <section className="panel" data-testid="matched-v4" aria-labelledby="v4-title">
        <h2 id="v4-title">Matched live benchmark v4</h2>
        {v4 ? <>
          <p>{v4.limits ?? 'Limits: Unavailable'}</p>
          <p className="muted small">Run {typeof v4.ranAt === 'string' ? v4.ranAt.slice(0, 10) : 'date Unavailable'}, from <code>benchmarks/results/matched-v4.json</code>. Self-run. Shown as recorded.</p>
          <Matched m={v4} testId="matched-v4-table" />
        </> : <p><b>Unavailable.</b> No v4 result is recorded. Version 3 above is the current result.</p>}
      </section>

      <h2>Mechanism test: fixed action traces</h2>
      {held ? <>
        <p>{held.scenarios} held-out scenarios, run {held.ranAt?.slice(0, 10)} at commit <code>{held.commit?.slice(0, 7)}</code>. No model in the loop, so this says nothing about task success, tokens or time. The same author wrote the system and the scenarios. Baseline B is a rule set we wrote, and is not any named product.</p>
        <div className="table-wrap" tabIndex={0}><table>
          <thead><tr><th scope="col">Condition</th><th scope="col">Prevented</th><th scope="col">Detected after</th><th scope="col">Missed</th><th scope="col">False blocks</th><th scope="col">False completions</th></tr></thead>
          <tbody>{Object.entries<any>(held.results).map(([n, t]) => <tr key={n}><th scope="row">{n.replace(/agentontrack/i, 'AgentOnTrack')}</th><td>{t.prevented}</td><td>{t.detectedAfter}</td><td>{t.missed}</td><td>{t.falseBlocks}</td><td>{t.falseCompletions}</td></tr>)}</tbody>
        </table></div>
      </> : <p>Unavailable</p>}
      <h2>Other runtimes</h2>
      {runtimes ? <p>{runtimes.summary}</p> : <p>Unavailable</p>}
      <h2>Live smoke test</h2>
      {live ? <p>Real Claude Code on {live.ranAt?.slice(0, 10)}: {live.actions?.length} gated actions. One cooperative sample per prompt. This is not an adversarial test.</p> : <p>Unavailable</p>}
      <h2>Hook latency</h2>
      {perf ? <><p>{perf.env}</p><div className="table-wrap" tabIndex={0}><table>
        <thead><tr><th scope="col">Measure</th><th scope="col">p50 (ms)</th><th scope="col">p95 (ms)</th><th scope="col">p99 (ms)</th></tr></thead>
        <tbody>{perf.rows.map((r: any) => <tr key={r.name}><th scope="row">{r.name}</th><td>{r.p50}</td><td>{r.p95}</td><td>{r.p99}</td></tr>)}</tbody>
      </table></div></> : <p>Unavailable</p>}
    </Article>
  );
}
