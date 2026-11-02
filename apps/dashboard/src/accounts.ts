// Optional accounts, on the public site only. With no config, the bundler drops the import below, so no Firebase code exists in this build.
import type { ProjectSummary } from './metrics';
import { onPublicSite } from './api';

const CONFIG = import.meta.env.VITE_FIREBASE_CONFIG as string | undefined;

export const accountsEnabled = () => Boolean(CONFIG) && onPublicSite();
/** Set by the account page after sign-in. Reading it needs no network, so this page can offer saving without loading Firebase. */
export const signedInHere = () => localStorage.getItem('aot-signed-in') === '1';
export const accountPage = () => `${import.meta.env.BASE_URL.replace(/dashboard\/$/, '')}account/`;

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
