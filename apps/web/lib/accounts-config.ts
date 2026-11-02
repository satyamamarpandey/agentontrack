// Whether this build of the site has optional accounts. With no config there is no sign-in UI, and the build holds no Firebase code.
export const ACCOUNTS_ENABLED = Boolean(process.env.NEXT_PUBLIC_FIREBASE_CONFIG);

/** Set after sign-in. Reading it needs no network, so a page can tell whether to load Firebase at all. */
export const SIGNED_IN_FLAG = 'aot-signed-in';

/** The only way into Firebase. Visitors who never ask for it never load it. */
export const loadAccounts = process.env.NEXT_PUBLIC_FIREBASE_CONFIG ? () => import('./accounts') : null;
