// Optional accounts, on the public site only. With no config, the bundler drops the imports below, so no Firebase code exists in this build.
import type { ProjectSummary } from './metrics';
import { onPublicSite } from './api';

const CONFIG = import.meta.env.VITE_FIREBASE_CONFIG as string | undefined;
const SITE = () => import.meta.env.BASE_URL.replace(/dashboard\/$/, '');

export const accountsEnabled = () => Boolean(CONFIG) && onPublicSite();
/** Set by the site after sign-in. Reading it needs no network, so this page can offer saving without loading Firebase. */
export const signedInHere = () => localStorage.getItem('aot-signed-in') === '1';
export const accountPage = () => `${SITE()}account/`;
export const signInPage = () => `${SITE()}sign-in/`;
export const earlyAccessPage = () => `${SITE()}early-access/`;

/**
 * Early access: while installs are gated, this site's dashboard connects a computer for approved testers only. The local address a companion prints
 * never asks. A build without accounts cannot gate anything. NEXT_PUBLIC_INSTALL_PUBLIC=1 (VITE_INSTALL_PUBLIC here) opens it to everyone again.
 */
export const connectGated = () => accountsEnabled() && import.meta.env.VITE_INSTALL_PUBLIC !== '1';

export type MemberStatus = 'active' | 'revoked' | 'none';
export interface AccessStatus { signedIn: boolean; member: MemberStatus; admin: boolean; email: string | null }

/** Asks Firestore for the signed-in person's own membership record. The rules decide; this only reads the answer. */
export async function checkAccess(): Promise<AccessStatus> {
  if (!CONFIG) throw new Error('Accounts are not set up on this site.');
  const { accessStatus } = await import('./accounts-firebase');
  return accessStatus(CONFIG);
}

export async function saveSummary(projectId: string, summary: ProjectSummary): Promise<void> {
  if (!CONFIG) throw new Error('Accounts are not set up on this site.');
  const { saveProjectSummary } = await import('./accounts-firebase');
  await saveProjectSummary(CONFIG, projectId, summary);
}

export async function sendCounts(installId: string, counts: import('./telemetry').UsageCounts): Promise<void> {
  if (!CONFIG) throw new Error('Sending is not set up on this site.');
  const { sendUsageCounts } = await import('./accounts-firebase');
  await sendUsageCounts(CONFIG, installId, counts);
}

/** The phone link's two halves are loaded only on request, and only in a build with accounts, so any other build holds no Firebase code at all. */
export async function linkBackend() {
  if (!CONFIG) throw new Error('Accounts are not set up on this site.');
  const m = await import('./link-backend');
  return { config: CONFIG, ...m };
}

export async function mobileBackend() {
  if (!CONFIG) throw new Error('Accounts are not set up on this site.');
  const m = await import('./mobile-backend');
  return m.openBackend(CONFIG);
}
