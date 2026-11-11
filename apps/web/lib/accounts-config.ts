// Whether this build of the site has optional accounts. With no config there is no sign-in UI, and the build holds no Firebase code.
export const ACCOUNTS_ENABLED = Boolean(process.env.NEXT_PUBLIC_FIREBASE_CONFIG);

/**
 * Early access: while this is on, the install page and the public-site dashboard's connection step are shown to approved testers only.
 * NEXT_PUBLIC_INSTALL_PUBLIC=1 opens them to everyone again. A build with no accounts cannot gate anything, so it is never gated.
 */
export const INSTALL_GATED = ACCOUNTS_ENABLED && process.env.NEXT_PUBLIC_INSTALL_PUBLIC !== '1';

/** Which sign-in buttons to show. Google and email are the default; GitHub needs an OAuth app the owner registers first. */
export const AUTH_PROVIDERS = (process.env.NEXT_PUBLIC_AUTH_PROVIDERS ?? 'google,password').split(',').map((s) => s.trim()).filter(Boolean);

export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Set after sign-in. Reading it needs no network, so a page can tell whether to load Firebase at all. */
export const SIGNED_IN_FLAG = 'aot-signed-in';

/** The only way into Firebase. Visitors who never ask for it never load it. */
export const loadAccounts = process.env.NEXT_PUBLIC_FIREBASE_CONFIG ? () => import('./accounts') : null;
