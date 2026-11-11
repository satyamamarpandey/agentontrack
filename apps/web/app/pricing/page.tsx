import { ACCOUNTS_ENABLED, INSTALL_GATED } from '../../lib/accounts-config';
import { Article } from '../content';
import Link from '../link';
import { RELEASE_PUBLISHED } from '../../lib/release';

export const metadata = { title: 'Pricing' };

export default function Pricing() {
  return (
    <Article title="Pricing" intro={ACCOUNTS_ENABLED ? 'AgentOnTrack is free. There is no paid tier, and nothing of yours runs on a server of ours. Accounts are free and used for early access.' : 'AgentOnTrack is free. There is no paid tier, no account and no server of ours to pay for.'}>
      <h2>What you still pay for</h2>
      <p>You bring your own agent, under your own login and plan. AgentOnTrack does not resell, pool or proxy model access. In our tests its hooks and context added model usage on top of what the agent alone used: see <Link href="/benchmarks">the benchmarks</Link>.</p>
      <h2>What is free</h2>
      <ul><li>The CLI, policy engine and evidence record</li><li>Agent adapters and the MCP server</li><li>The local dashboard, and this site's dashboard</li></ul>
      <h2>Local-first</h2>
      <p>Everything runs on your machine. {ACCOUNTS_ENABLED ? 'No account is needed for the program itself.' : 'No account exists to create.'} See <Link href="/privacy">privacy</Link>.</p>
      <h2>Availability</h2>
      <p>{RELEASE_PUBLISHED ? 'Open source, Apache-2.0 licence.' : 'Open source once published. The v1.0 release candidate is awaiting the owner\'s approval, so nothing can be installed yet.'} {INSTALL_GATED ? <>During early access the guided install is open to invited testers: <Link href="/early-access">apply here</Link>.</> : <>See <Link href="/install">the install page</Link>.</>}</p>
    </Article>
  );
}
