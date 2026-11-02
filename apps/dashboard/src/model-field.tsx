import { get } from './api';
import { useLoad } from './ui';

export interface DiscoveredModel { id: string; agent: string; source: string; entitlement: 'worked' | 'unknown'; note: string }
export interface DiscoveredAgent { id: string; name: string; status: 'ready' | 'needs-setup' | 'terminal-only' | 'missing'; canStart: boolean; reason: string | null; commands: string[]; commandsSource: string }
export interface Discovery { agents: DiscoveredAgent[]; models: DiscoveredModel[]; note: string }

/** What this computer reports: the agents with a status, and the models it has seen. Loaded from the companion, never built in. */
export const useDiscovery = (tick: unknown = 0) => useLoad<Discovery>(() => get('/api/discovery'), [tick]);

export const AGENT_STATUS: Record<DiscoveredAgent['status'], string> = { ready: 'Ready', 'needs-setup': 'Needs setup', 'terminal-only': 'Runs in its own terminal', missing: 'Not installed' };

/**
 * A model box that suggests the models found for the chosen agent, searchable as you type. A name you type that was not found is allowed,
 * and the line under it says so: being listed never means your plan allows it, and being typed never means it is wrong.
 */
export function ModelField({ agent, value, onChange, name, models, width = 160, placeholder = 'Auto' }: { agent: string; value: string; onChange: (v: string) => void; name: string; models: DiscoveredModel[] | undefined; width?: number; placeholder?: string }) {
  const mine = (models ?? []).filter((m) => m.agent === agent);
  const hit = mine.find((m) => m.id === value);
  const listId = `models-${agent}-${name}`;
  return (
    <span className="stack">
      <label>Model
      <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} name={name} style={{ width }} list={listId} autoComplete="off" aria-describedby={`${listId}-note`} />
      <datalist id={listId}>{mine.map((m) => <option key={m.id} value={m.id}>{m.entitlement === 'worked' ? 'worked in a run here' : 'found, not tried'}</option>)}</datalist>
      </label>
      <span id={`${listId}-note`} className="muted small" data-testid="model-note">
        {!value ? (mine.length ? `${mine.length} found on this computer.` : 'None found yet, so the agent chooses.')
          : hit ? (hit.entitlement === 'worked' ? 'A run here used it successfully.' : 'Found on this computer. Whether your plan allows it is not known until a run uses it.')
            : 'Not found on this computer. It is used as typed, and the agent will refuse it if it is not available to you.'}
      </span>
    </span>
  );
}
