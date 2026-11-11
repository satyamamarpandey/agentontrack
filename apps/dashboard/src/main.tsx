import { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { isDemo, resumeSession } from './api';
import { Entry } from './entry';
import './styles.css';

// The application is its own chunk. A visitor who lands on the public site's dashboard sees the welcome gate (sign in, connect, or the demo)
// without downloading or evaluating the whole dashboard first; the chunk is fetched when a session exists, after pairing, or for the demo.
const App = lazy(() => import('./App').then((m) => ({ default: m.App })));

function Root() {
  const [state, setState] = useState<'checking' | 'gate' | 'app'>(() => (isDemo() ? 'app' : 'checking'));
  useEffect(() => {
    if (state !== 'checking') return;
    resumeSession().then((ok) => setState(ok ? 'app' : 'gate')).catch(() => setState('gate'));
  }, [state]);
  if (state === 'checking') return <p className="muted center" role="status">Connecting…</p>;
  if (state === 'gate') return <Entry onPaired={() => setState('app')} />;
  return <Suspense fallback={<p className="muted center" role="status">Loading…</p>}><App /></Suspense>;
}

// The saved theme applies before anything renders: the application used to do this on mount, and the gate now shows without it.
try { document.documentElement.dataset.theme = localStorage.getItem('bl-theme') ?? 'dark'; } catch { /* storage may be blocked */ }

const phone = new URLSearchParams(location.search).get('m') === '1';
const root = createRoot(document.getElementById('root')!);
if (phone) {
  void Promise.all([import('./mobile'), import('./mobile.css')]).then(([m]) => root.render(<m.MobileApp />));
} else {
  root.render(<Root />);
}
