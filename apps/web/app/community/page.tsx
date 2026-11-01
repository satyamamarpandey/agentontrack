import { Article } from '../content';
import Link from '../link';
import { ADVISORY, DISCUSSIONS, DISCUSSIONS_ENABLED, ISSUES } from '../../lib/release';

export const metadata = { title: 'Community' };

export default function Community() {
  return (
    <Article title="Community" intro="AgentOnTrack is early, and has no community yet. All of this is optional, and nothing here is needed to use it.">
      <h2>Where to talk</h2>
      <ul>
        <li><b>Bugs and requests:</b> <a href={ISSUES}>GitHub Issues</a>, on the public repository. Or use the <Link href="/feedback">feedback form</Link>, which prefills one.</li>
        <li><b>Questions and ideas:</b> {DISCUSSIONS_ENABLED ? <a href={DISCUSSIONS}>GitHub Discussions</a> : <>GitHub Discussions: Unavailable, not yet switched on. Use Issues for now.</>}</li>
        <li><b>Vulnerabilities:</b> <a href={ADVISORY}>a private security advisory</a>, not a public issue.</li>
      </ul>
      <h2>Contribute</h2>
      <p>Bypass reports, negative results and independent benchmark reproductions are especially useful, including ones that make this project look worse.</p>
      <h2>Reproduce the results</h2>
      <p>Results from someone other than the author would be the most valuable contribution right now, including unfavourable ones. If you would evaluate it independently, <a href={`${ISSUES}/new?title=Independent%20evaluation`}>open an issue</a>.</p>
    </Article>
  );
}
