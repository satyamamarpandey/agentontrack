import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const phone = new URLSearchParams(location.search).get('m') === '1';
const root = createRoot(document.getElementById('root')!);
if (phone) {
  void Promise.all([import('./mobile'), import('./mobile.css')]).then(([m]) => root.render(<m.MobileApp />));
} else {
  root.render(<App />);
}
