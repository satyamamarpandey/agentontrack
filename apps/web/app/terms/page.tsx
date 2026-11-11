import { ACCOUNTS_ENABLED, INSTALL_GATED } from '../../lib/accounts-config';
import { Article } from '../content';
import { RELEASE_PUBLISHED } from '../../lib/release';

export const metadata = { title: 'Terms' };

export default function Terms() {
  return (
    <Article title="Terms" intro="Draft pending legal review.">
      <h2>Software</h2><p>AgentOnTrack is free to use, and provided without warranty. {RELEASE_PUBLISHED ? 'The Apache-2.0 licence that comes with it applies.' : 'The Apache-2.0 licence will apply once it is published.'} It reduces some risks; it does not remove them. You stay responsible for what your agents do.</p>
      {INSTALL_GATED ? <><h2>Early access</h2><p>During early access the guided install and this site's dashboard connection step are offered to invited testers. An invitation is personal, works once and expires; access can be withdrawn. The source code and releases remain public under their licence. A pre-release is not finished software: expect rough edges, and keep your own backups.</p></> : null}
      <h2>Your providers</h2><p>You use your own agents under your own accounts and their terms. AgentOnTrack does not pool, proxy or resell model access.</p>
      <h2>No hosted execution</h2><p>{ACCOUNTS_ENABLED ? 'Nothing of yours runs on a server of ours. Accounts on this site (early access, profile, optional cloud features) are stored in Firebase, under Google\'s terms.' : 'There are no accounts and no hosted service.'} This website is static. Its dashboard demo shows invented data, and is labelled so.</p>
      <h2>Results</h2><p>Benchmarks on this site are self-run, on self-authored fixtures. They say nothing certain about your projects.</p>
    </Article>
  );
}
