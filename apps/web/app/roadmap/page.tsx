import { Article } from '../content';
import { RELEASE_PUBLISHED } from '../../lib/release';

export const metadata = { title: 'Roadmap' };

export default function Roadmap() {
  return (
    <Article title="Roadmap" intro="Honest priorities. Dates are not promised.">
      <h2>Now</h2><ul>{RELEASE_PUBLISHED ? null : <li>Publish v1.0, once the owner approves it</li>}<li>Live runs on Codex and Hermes with their normal hosted models</li><li>A Hermes run where the gate really blocks an action</li><li>Testing the Claude Code sandbox option on Linux and macOS</li><li>Independent reproduction of the benchmarks</li></ul>
      <h2>Next</h2><ul><li>A larger matched benchmark on real tasks, including a named competitor comparison</li><li>Long tasks, forced compaction and live cross-runtime handoff</li><li>Starting Codex and Hermes from the dashboard</li><li>Anchoring the log automatically, not only when you configure it</li></ul>
      <h2>Later</h2><ul><li>Bounded tool output</li><li>Passkeys</li><li>Measured local energy where hardware exposes it</li></ul>
    </Article>
  );
}
