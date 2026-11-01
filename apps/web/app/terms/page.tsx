import { Article } from '../content';
import { RELEASE_PUBLISHED } from '../../lib/release';

export const metadata = { title: 'Terms' };

export default function Terms() {
  return (
    <Article title="Terms" intro="Draft pending legal review.">
      <h2>Software</h2><p>AgentOnTrack is free to use, and provided without warranty. {RELEASE_PUBLISHED ? 'The Apache-2.0 licence that comes with it applies.' : 'The Apache-2.0 licence will apply once it is published.'} It reduces some risks; it does not remove them. You stay responsible for what your agents do.</p>
      <h2>Your providers</h2><p>You use your own agents under your own accounts and their terms. AgentOnTrack does not pool, proxy or resell model access.</p>
      <h2>No hosted service</h2><p>There are no accounts and no hosted service. This website is static. Its dashboard demo shows invented data, and is labelled so.</p>
      <h2>Results</h2><p>Benchmarks on this site are self-run, on self-authored fixtures. They say nothing certain about your projects.</p>
    </Article>
  );
}
