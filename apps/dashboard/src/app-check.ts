import type { FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';

const KEY = import.meta.env.VITE_APPCHECK_KEY as string | undefined;

/**
 * Asks Firebase to attach an App Check token to this page's calls, so only the real site (not a script that copied the public config) can use them.
 * Off without a key, and off against the emulators. It is a defence against abuse, not a login: the keys, the rules and the computer's own file decide access.
 */
export function protect(app: FirebaseApp, emulators = false): boolean {
  if (!KEY || emulators) return false;
  initializeAppCheck(app, { provider: new ReCaptchaV3Provider(KEY), isTokenAutoRefreshEnabled: true });
  return true;
}
