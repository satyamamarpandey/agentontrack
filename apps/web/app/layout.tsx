import type { Metadata } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import Link from './link';
import './globals.css';

// Self-hosted and preloaded by Next, with fallback metrics matched automatically, so the headline does not move when the font arrives.
const inter = localFont({ src: './fonts/inter.woff2', variable: '--font-inter', display: 'swap', weight: '100 900' });
import { ACCOUNTS_ENABLED, INSTALL_GATED } from '../lib/accounts-config';
import { SOURCE_STATUS } from '../lib/release';
import { EarlyAccessButton, EarlyAccessHost } from './early-access/launcher';
import { NavAuth } from './nav-auth';
import { NavLink } from './nav-link';
import { NavMenu } from './nav-menu';
import { ThemeToggle } from './theme-toggle';
import { Mark } from './ui/icons';
import { Effects } from './ui/effects';
import { Toasts } from './ui/toast';

export const metadata: Metadata = {
  title: { default: 'AgentOnTrack: a control layer for AI coding agents', template: '%s · AgentOnTrack' },
  description: 'Set the goal, approve what matters, and let evidence decide when the task is done. Local-first, open source, bring your own agent.',
};

// A short primary row that fits on one line at laptop widths; the rest of the pages are a step away in the footer.
const NAV = [['/features', 'Features'], ['/how-it-works', 'How it works'], ['/integrations', 'Integrations'], ['/security', 'Security'], ['/docs', 'Docs'], ['/install', 'Install']];
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const FOOT = [['/early-access', 'Early access'], ['/benchmarks', 'Benchmarks'], ['/pricing', 'Pricing'], ['/community', 'Community'], ['/roadmap', 'Roadmap'], ['/changelog', 'Changelog'], ['/feedback', 'Feedback'], ['/privacy', 'Privacy'], ['/terms', 'Terms']];
// Set before first paint, so a saved light theme does not flash dark.
const THEME_SCRIPT = "try{var t=localStorage.getItem('bl-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <meta name="color-scheme" content="dark light" />
        <meta name="theme-color" content="#0b0b0c" />
      </head>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <header className="top">
          <div className="wrap top-in">
            <Link href="/" className="logo"><Mark />AgentOnTrack</Link>
            <NavMenu>
              <a href={`${BASE}/dashboard/#projects`} data-testid="nav-projects">Projects</a>
              {NAV.map(([href, label]) => <NavLink key={href} href={href!}>{label}</NavLink>)}
              {ACCOUNTS_ENABLED ? <NavLink href="/account" data-testid="nav-account">Account</NavLink> : null}
            </NavMenu>
            <div className="top-end">
              <ThemeToggle />
              <a className="btn small ghost nav-dashboard" href={`${BASE}/dashboard/`}>Dashboard</a>
              {ACCOUNTS_ENABLED ? <NavAuth /> : null}
              <EarlyAccessButton className="btn small primary" testId="nav-early-access">Early access</EarlyAccessButton>
            </div>
          </div>
        </header>
        <main id="main">{children}</main>
        <footer className="foot">
          <div className="wrap foot-in">
            <div>
              <Link href="/" className="logo"><Mark />AgentOnTrack</Link>
              <p style={{ marginTop: 10 }}>A control layer for AI coding agents. Local-first, open source, bring your own agent.{INSTALL_GATED ? ' In early access: the software is open to invited testers first.' : ''}</p>
            </div>
            <div>
              <nav aria-label="Footer" className="foot-nav">{FOOT.map(([href, label]) => <Link key={href} href={href!}>{label}</Link>)}</nav>
              <p>{SOURCE_STATUS} Not affiliated with or endorsed by Anthropic, OpenAI or Nous Research.</p>
            </div>
          </div>
        </footer>
        <EarlyAccessHost />
        <Toasts />
        <Effects />
      </body>
    </html>
  );
}
