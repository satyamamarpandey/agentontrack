import { ACCOUNTS_ENABLED } from '../../lib/accounts-config';
import { Article } from '../content';
import { JoinScreen } from './screen';

export const metadata = { title: 'Your invitation' };

export default function Join() {
  if (!ACCOUNTS_ENABLED) return <Article title="Your invitation" intro="This build of the site has no accounts, so invitations cannot be used here."><p>Open the link on the live site instead.</p></Article>;
  return <JoinScreen />;
}
