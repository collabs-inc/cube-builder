/**
 * One-shot hint from a tab or keyboard screen jump to the rail: "cut to this
 * screen, do not slide". The workspace store holds arrangement only and
 * says nothing about HOW the rail should reach a newly active screen —
 * navigation otherwise slides (`screen-scroll.ts`). Tab clicks and Cmd+number
 * arrive instantly. The requester marks the target id before calling
 * `setActiveView`; Rail takes the mark in the layout effect that feeds the
 * scroller and honours it only when it names the screen now active, so a
 * mark left behind by a no-op selection is discarded rather than making
 * some later, unrelated slide jump.
 */
let instantScreenId: string | null = null;

/** Ask the rail to reach screen `id` with an instant scroll, once. */
export function requestInstantScreenNavigation(id: string): void {
  instantScreenId = id;
}

/** The pending instant-jump target, cleared on read. */
export function takeInstantScreenNavigation(): string | null {
  const id = instantScreenId;
  instantScreenId = null;
  return id;
}
