import { useEffect, useState } from 'react';
import { services } from './services/http';
export interface Preferences { agent: string; shell: string; fontSize: number; confirmClose: boolean }
export function loadPreferences(): Preferences { try { return { agent: 'codex', shell: '', fontSize: 12, confirmClose: true, ...JSON.parse(localStorage.getItem('cube-builder.preferences') || '{}') }; } catch { return { agent: 'codex', shell: '', fontSize: 12, confirmClose: true }; } }
export function Settings({ preferences, save, close, stopAll }: { preferences: Preferences; save: (p: Preferences) => void; close: () => void; stopAll: () => void }) {
  const [agents, setAgents] = useState<{ id: string; name: string; available: boolean }[]>([]), [error, setError] = useState('');
  useEffect(() => { void services.call('agents.list', {}).then(setAgents, error => setError(String(error))); }, []);
  return <div className="dialog-backdrop"><form className="builder-dialog" role="dialog" aria-label="Settings" onSubmit={event => { event.preventDefault(); close(); }}><h2>Settings</h2>
    <label>Default agent<select value={preferences.agent} onChange={e => save({ ...preferences, agent: e.target.value })}>{agents.map(a => <option key={a.id} value={a.id} disabled={!a.available}>{a.name}{a.available ? '' : ' — not installed'}</option>)}</select></label>
    <label>Shell executable (empty uses the machine default)<input value={preferences.shell} onChange={e => save({ ...preferences, shell: e.target.value })} /></label>
    <label>Terminal text size<input type="number" min="10" max="24" value={preferences.fontSize} onChange={e => { const n = Number(e.target.value); if (n >= 10 && n <= 24) save({ ...preferences, fontSize: n }); }} /></label>
    <label><span><input type="checkbox" checked={preferences.confirmClose} onChange={e => save({ ...preferences, confirmClose: e.target.checked })} /> Confirm before stopping a terminal</span></label>
    <p>Terminals keep running when you hide panes, close the browser, stop the app server, or update the app. Stop them here before uninstalling if you want them to end.</p>
    <button type="button" onClick={stopAll}>Stop all Builder terminals…</button>{error && <p role="alert">{error}</p>}
    <p>Shortcuts: Ctrl/⌘ + Alt + 1–9 selects a screen; N creates one; W hides a pane; Enter zooms it. Arrow keys focus a neighboring pane; add Shift to move it.</p><footer><button>Done</button></footer></form></div>;
}
