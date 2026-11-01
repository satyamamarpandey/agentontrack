import type { ReactNode } from 'react';
import { NOTICE, RELEASE_PUBLISHED, RELEASE_VERSION } from '../lib/release';

export const Article = ({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) => (
  <article className="wrap article">
    <h1>{title}</h1>
    {intro ? <p className="lead">{intro}</p> : null}
    {children}
  </article>
);

/** Shown next to any install command, for as long as there is nothing to install. */
export const ReleaseNotice = () => (RELEASE_PUBLISHED
  ? <p className="muted small" data-testid="release-state" data-published="true">Current release: {RELEASE_VERSION}</p>
  : <p className="alert" role="note" data-testid="release-state" data-published="false"><b>{NOTICE}</b> No release is public yet, and the owner must approve publication. These commands are what will work then.</p>);

export const Term = ({ label, children }: { label: string; children: string }) => <pre className="term" tabIndex={0} aria-label={label}><code>{children}</code></pre>;
