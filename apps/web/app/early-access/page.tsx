import { Icon } from '../ui/icons';
import { EarlyAccessForm } from './form';

export const metadata = { title: 'Early access', description: 'Apply to test AgentOnTrack before it opens to everyone. A small, hand-picked group; your own agents, on your own machine.' };

const WHAT = [
  ['The desktop preview', 'The current pre-release for Windows, macOS and Linux, with the install steps and a direct line to the maintainer when something is wrong.'],
  ['Your agents, your machine', 'AgentOnTrack governs the Claude Code and Codex you already run, under your own logins. Nothing of yours goes through a server of ours.'],
  ['A say in what comes next', 'Which connectors, which approvals, which views. Early testers see each change first and their reports shape the order.'],
];

export default function EarlyAccess() {
  return (
    <div className="wrap auth">
      <div className="auth-side">
        <p className="eyebrow">Early access</p>
        <h1>Test AgentOnTrack before it opens to everyone.</h1>
        <p className="lead">A control layer for AI coding agents: you set the goal and approve what matters, your agents do the work, and independent checks decide when it is done. Places are limited and given by hand.</p>
        <ul className="plain" style={{ marginTop: 24 }}>
          {WHAT.map(([t, d]) => <li key={t} style={{ display: 'flex', gap: 12 }}><span className="step-icon" style={{ marginBottom: 0, flex: 'none' }}><Icon name="check" /></span><span><b>{t}.</b> <span className="muted">{d}</span></span></li>)}
        </ul>
        <p className="small muted">Applications go to the maintainer only. Approved applicants receive a personal invitation link that works once, for their address, and expires. There is no public sign-up.</p>
      </div>
      <div className="auth-card" id="apply">
        <EarlyAccessForm source="page" />
      </div>
    </div>
  );
}
