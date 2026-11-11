'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from './link';
import { SIGNED_IN_FLAG } from '../lib/accounts-config';

/**
 * The header's account action. It is rendered as "Sign in" (what the server and a first-time visitor get, so nothing shifts), and becomes
 * "Account" once this browser has signed in. It reads only the flag the sign-in code sets, so it loads no Firebase code; the flag is removed on
 * sign-out and whenever a page finds that there is no session, and the account page decides what is real.
 */
export function NavAuth() {
  const path = usePathname();
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    const read = () => { try { setSignedIn(localStorage.getItem(SIGNED_IN_FLAG) === '1'); } catch { setSignedIn(false); } };
    read();
    window.addEventListener('storage', read);
    return () => window.removeEventListener('storage', read);
  }, [path]);
  return signedIn
    ? <Link className="btn small ghost nav-signin" href="/account" data-testid="nav-account-action">Account</Link>
    : <Link className="btn small ghost nav-signin" href="/sign-in" data-testid="nav-signin">Sign in</Link>;
}
