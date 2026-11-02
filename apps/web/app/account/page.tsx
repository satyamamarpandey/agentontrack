import { ACCOUNTS_ENABLED } from '../../lib/accounts-config';
import { Article } from '../content';
import { AccountPanel } from './panel';

export const metadata = { title: 'Account' };

export default function Account() {
  return ACCOUNTS_ENABLED
    ? <Article title="Your account" intro="Optional. Every part of AgentOnTrack works without one."><AccountPanel /></Article>
    : <Article title="Account" intro="This build of the site has no accounts."><p>Nothing here needs one, and no data about you is kept.</p></Article>;
}
