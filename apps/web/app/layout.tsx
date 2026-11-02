import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from './link';
import './globals.css';
import { ACCOUNTS_ENABLED } from '../lib/accounts-config';
import { SOURCE_STATUS } from '../lib/release';
import { NavMenu } from './nav-menu';
import { ThemeToggle } from './theme-toggle';

export const metadata: Metadata = {
  title: { default: 'AgentOnTrack: a control layer for AI coding agents', template: '%s · AgentOnTrack' },
  description: 'Free and local-first. Set the goal, approve what matters, and let evidence decide when the task is done.',
};

const NAV = [['/features', 'Features'], ['/how-it-works', 'How it works'], ['/integrations', 'Integrations'], ['/benchmarks', 'Benchmarks'], ['/security', 'Security'], ['/pricing', 'Pricing'], ['/docs', 'Docs']];
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const FOOT = [['/community', 'Community'], ['/roadmap', 'Roadmap'], ['/changelog', 'Changelog'], ['/feedback', 'Feedback'], ['/privacy', 'Privacy'], ['/terms', 'Terms']];
// Set before first paint, so a saved light theme does not flash dark.
const THEME_SCRIPT = "try{var t=localStorage.getItem('bl-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <header className="top">
          <div className="wrap top-in">
            <Link href="/" className="logo"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M4 12h16M4 18h7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /><circle cx="19" cy="6" r="2" fill="var(--accent)" /><circle cx="15" cy="18" r="2" fill="var(--accent)" /></svg>AgentOnTrack</Link>
            <NavMenu>
              <a href={`${BASE}/dashboard/#projects`} data-testid="nav-projects">Projects</a>
              {NAV.map(([href, label]) => <Link key={href} href={href!}>{label}</Link>)}
              {ACCOUNTS_ENABLED ? <Link href="/account" data-testid="nav-account">Account</Link> : null}
            </NavMenu>
            <div className="top-end"><ThemeToggle /><a className="btn small nav-dashboard" href={`${BASE}/dashboard/`}>Dashboard</a><Link className="btn small primary" href="/install">Install</Link></div>
          </div>
        </header>
        <main id="main">{children}</main>
        <footer className="foot">
          <div className="wrap foot-in">
            <nav aria-label="Footer" className="foot-nav">{FOOT.map(([href, label]) => <Link key={href} href={href!}>{label}</Link>)}</nav>
            <p>{SOURCE_STATUS} Not affiliated with or endorsed by Anthropic, OpenAI or Nous Research.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
