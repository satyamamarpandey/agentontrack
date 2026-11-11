import { ACCOUNTS_ENABLED } from '../../lib/accounts-config';
import { Article } from '../content';
import { SignInScreen } from './screen';

export const metadata = { title: 'Sign in' };

export default function SignIn() {
  if (!ACCOUNTS_ENABLED) return <Article title="No accounts on this build" intro="This build of the site has no accounts."><p>Nothing here needs one, and no data about you is kept.</p></Article>;
  return <SignInScreen />;
}
