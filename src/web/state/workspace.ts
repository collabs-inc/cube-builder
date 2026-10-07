import { type MoveTarget, resizePaneRatio } from './layout-ops';
import { type Screen, repairScreens, nearestScreenPlacing, insertScreenPane, moveScreenPane, removeScreenPane, reconcileScreens, resizeScreenDivider } from './screen-ops';
export interface WorkspaceState { screens: Screen[]; activeScreenId: string; activeItemId: string | null; mounted: string[]; zoom: string | null }
export function createWorkspace(id: string, storage: Storage) {
  const key = `cube-builder.workspace.${id}`;
  const uid = () => crypto.randomUUID();
  const blank = (): Screen => ({ id: uid(), name: '', columns: [] });
  let state: WorkspaceState = { screens: [blank()], activeScreenId: '', activeItemId: null, mounted: [], zoom: null };
  try {
    const raw = JSON.parse(storage.getItem(key) || 'null');
    if (raw) {
      const screens = repairScreens(raw.screens, uid);
      if (screens.length) state = { ...state, screens, activeScreenId: raw.activeScreenId, activeItemId: typeof raw.activeItemId === 'string' ? raw.activeItemId : null,
        mounted: Array.isArray(raw.mounted) ? [...new Set<string>(raw.mounted.filter((v: unknown) => typeof v === 'string'))] : [] };
    }
  } catch { /* A damaged layout does not prevent opening the app. */ }
  if (!state.screens.some(s => s.id === state.activeScreenId)) state.activeScreenId = state.screens[0]!.id;
  const listeners = new Set<() => void>();
  const save = (next: WorkspaceState) => { state = next; try { storage.setItem(key, JSON.stringify(state)); } catch { /* Storage may be unavailable. */ } listeners.forEach(fn => fn()); };
  const updateScreen = (fn: (s: Screen) => Screen) => save({ ...state, screens: state.screens.map(s => s.id === state.activeScreenId ? fn(s) : s) });
  return {
    get: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    open(itemId: string) {
      const activeScreenId = nearestScreenPlacing(state.screens, state.activeScreenId, itemId) ?? state.activeScreenId;
      save({ ...state, activeScreenId, activeItemId: itemId, zoom: null, mounted: state.mounted.includes(itemId) ? state.mounted : [...state.mounted, itemId],
        screens: state.screens.map(s => s.id !== activeScreenId || s.columns.some(c => c.panes.some(p => p.itemId === itemId)) ? s : insertScreenPane(s, itemId, { kind: 'column', railIndex: s.columns.length }, uid())) });
    },
    focus: (itemId: string) => save({ ...state, activeItemId: itemId }),
    selectScreen: (activeScreenId: string) => { const screen = state.screens.find(s => s.id === activeScreenId); if (screen) save({ ...state, activeScreenId, activeItemId: screen.columns.flatMap(c => c.panes).find(p => p.itemId === state.activeItemId)?.itemId ?? screen.columns[0]?.panes[0]?.itemId ?? null, zoom: null }); },
    newScreen() { const screen = blank(); save({ ...state, screens: [...state.screens, screen], activeScreenId: screen.id, activeItemId: null, zoom: null }); },
    renameScreen: (id: string, name: string) => save({ ...state, screens: state.screens.map(s => s.id === id ? { ...s, name, customName: true } : s) }),
    hide(itemId: string) { const screens = state.screens.map(s => s.id === state.activeScreenId ? removeScreenPane(s, itemId) : s); const screen = screens.find(s => s.id === state.activeScreenId)!; save({ ...state, screens, activeItemId: state.activeItemId === itemId ? screen.columns[0]?.panes[0]?.itemId ?? null : state.activeItemId, zoom: state.zoom === itemId ? null : state.zoom }); },
    move: (itemId: string, target: MoveTarget) => updateScreen(s => moveScreenPane(s, itemId, target, uid())),
    resizeColumn: (columnId: string, delta: number) => updateScreen(s => resizeScreenDivider(s, columnId, delta)),
    resizePane: (columnId: string, seamIndex: number, delta: number) => updateScreen(s => ({ ...s, columns: resizePaneRatio(s.columns, columnId, seamIndex, delta) })),
    zoom: (itemId: string) => save({ ...state, zoom: state.zoom === itemId ? null : itemId }),
    reconcile(ids: string[]) { const known = new Set(ids); save({ ...state, screens: reconcileScreens(state.screens, known), mounted: state.mounted.filter(id => known.has(id)) }); },
  };
}
export type Workspace = ReturnType<typeof createWorkspace>;
