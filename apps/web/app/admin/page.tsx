import { ACCOUNTS_ENABLED } from '../../lib/accounts-config';
import { Article } from '../content';
import { AdminPanel } from './panel';

export const metadata = { title: 'Early access review', robots: { index: false, follow: false } };

export default function Admin() {
  if (!ACCOUNTS_ENABLED) return <Article title="Early access review" intro="This build of the site has no accounts."><p>There is nothing to review here.</p></Article>;
  return <AdminPanel />;
}
