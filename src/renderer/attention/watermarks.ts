/**
 * The last completion this client has seen, per item: the row's own
 * `turnEndedAt` value, copied verbatim when the item is on screen.
 *
 * Kept in `localStorage` for every catalog row, not just mounted ones — the
 * rows a client never opened are exactly the ones the sidebar and the phone
 * need to light. Writes merge with what is stored by taking the later
 * stamp, so two windows sharing the storage can only ever advance one
 * another, never rewind.
 */
const STORAGE_KEY = "cube.attention.watermarks.v1";
const MAX_ENTRIES = 2_000;

export type Watermarks = Readonly<Record<string, string | null>>;

const subscribers = new Set<() => void>();
let marks: Watermarks = load();

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): Record<string, string | null> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null) return {};
    const out: Record<string, string | null> = {};
    for (const [id, mark] of Object.entries(value)) {
      if (mark === null || typeof mark === "string") out[id] = mark;
    }
    return out;
  } catch {
    return {};
  }
}

function load(): Watermarks {
  return parse(storage()?.getItem(STORAGE_KEY) ?? null);
}

function later(a: string | null | undefined, b: string | null | undefined): string | null | undefined {
  if (a === undefined) return b;
  if (b === undefined || b === null) return a;
  if (a === null) return b;
  return a >= b ? a : b;
}

function commit(next: Record<string, string | null>, liveIds?: ReadonlySet<string>): void {
  const store = storage();
  const merged: Record<string, string | null> = { ...parse(store?.getItem(STORAGE_KEY) ?? null) };
  for (const [id, mark] of Object.entries(next)) merged[id] = later(merged[id], mark) ?? null;
  if (liveIds && Object.keys(merged).length > MAX_ENTRIES) {
    for (const id of Object.keys(merged)) if (!liveIds.has(id)) delete merged[id];
  }
  marks = merged;
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Quota or a disabled store: watermarks still hold for this session.
  }
  for (const callback of subscribers) callback();
}

/** First sight of a row: whatever it has already finished is not news. */
export function observeItems(items: ReadonlyArray<{ id: string; turnEndedAt?: string }>): void {
  let next: Record<string, string | null> | null = null;
  for (const item of items) {
    if (item.id in marks) continue;
    next ??= { ...marks };
    next[item.id] = item.turnEndedAt ?? null;
  }
  if (next) commit(next, new Set(items.map(item => item.id)));
}

export function acknowledge(itemId: string, turnEndedAt: string): void {
  const current = marks[itemId];
  if (typeof current === "string" && current >= turnEndedAt) return;
  commit({ ...marks, [itemId]: turnEndedAt });
}

export const watermarkStore = {
  subscribe(callback: () => void): () => void {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  },
  getSnapshot(): Watermarks {
    return marks;
  },
};

export function resetWatermarksForTests(): void {
  storage()?.removeItem(STORAGE_KEY);
  marks = {};
  for (const callback of subscribers) callback();
}
