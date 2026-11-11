import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface Command { id: string; label: string; group: string; hint?: string; run: () => void }

/** A subsequence match with a bonus for matches at word starts, so "wsf" finds "Workspace: show files". */
function score(q: string, label: string): number {
  if (!q) return 1;
  const l = label.toLowerCase(); let s = 0; let at = 0; let prev = -2;
  for (const ch of q.toLowerCase()) {
    const i = l.indexOf(ch, at);
    if (i < 0) return 0;
    s += i === prev + 1 ? 3 : /[\s/:._-]/.test(l[i - 1] ?? ' ') ? 2 : 1;
    prev = i; at = i + 1;
  }
  return s;
}

export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => commands.map((c) => ({ c, s: score(q, `${c.group} ${c.label}`) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 50).map((x) => x.c), [q, commands]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    input.current?.focus();
    return () => { root?.removeAttribute('inert'); opener?.focus?.(); };
  }, []);
  useEffect(() => setI(0), [q]);
  const run = (c: Command | undefined) => { if (!c) return; onClose(); setTimeout(c.run, 0); };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setI((n) => Math.min(n + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((n) => Math.max(n - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(list[i]); }
    else if (e.key === 'Tab') e.preventDefault();
  };
  return createPortal(
    <div className="palette-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={key}>
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a command, screen or file" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={list[i] ? `pal-${list[i]!.id}` : undefined} aria-label="Search commands" autoComplete="off" spellCheck={false} />
        {list.length ? <ul id="palette-list" role="listbox" aria-label="Commands">{list.map((c, n) => (
          <li key={c.id} id={`pal-${c.id}`} role="option" aria-selected={n === i} onMouseMove={() => setI(n)} onMouseDown={(e) => { e.preventDefault(); run(c); }}>
            <span>{c.label}</span>{c.hint ? <kbd>{c.hint}</kbd> : null}<span className="group">{c.group}</span>
          </li>))}</ul> : <p className="none" role="status">Nothing matches “{q}”.</p>}
        <div className="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> run</span><span><kbd>Esc</kbd> close</span><span><kbd>G</kbd> then <kbd>P</kbd> <kbd>W</kbd> <kbd>A</kbd> <kbd>V</kbd> <kbd>U</kbd> <kbd>S</kbd> jump</span></div>
      </div>
    </div>,
    document.body,
  );
}
