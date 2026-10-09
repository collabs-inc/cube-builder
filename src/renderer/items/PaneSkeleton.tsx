import type { CatalogItemType } from "@port/shared/catalog";

/** Static type cues, not a loading animation or a copy of the live content. */
export function PaneSkeleton({ type }: { type: CatalogItemType | "tree" }) {
  const kind = type === "term" ? "terminal" : type === "agent" ? "conversation"
    : type === "artifact" || type === "app" ? "preview" : type === "note" ? "document" : type;
  // A preview or image fills its pane, so its frame is the pane's own edge, not a card in the middle.
  if (kind === "preview" || kind === "image") return (
    <div className="rail-pane-skeleton rail-pane-skeleton-frame" data-skeleton-kind={kind} aria-hidden="true">
      <svg viewBox="0 0 244 160" preserveAspectRatio="xMinYMin meet">
        <rect x="0" y="0" width="70" height="7" rx="3.5" />
        <rect x="0" y="26" width="244" height="83" rx="5" opacity=".5" />
        <rect x="0" y="128" width="205" height="7" rx="3.5" />
        <rect x="0" y="145" width="149" height="7" rx="3.5" />
      </svg>
    </div>
  );
  return (
    <svg className="rail-pane-skeleton" data-skeleton-kind={kind} viewBox="0 0 320 230" aria-hidden="true">
      {kind === "conversation" ? <>
        <rect x="82" y="20" width="216" height="46" rx="12" opacity=".6" />
        <circle cx="30" cy="104" r="10" />
        {[160, 230, 190].map((width, index) => <rect key={index} x="52" y={97 + index * 20} width={width} height="7" rx="3.5" />)}
        <rect x="110" y="170" width="188" height="40" rx="12" opacity=".6" />
      </> : <>
        {kind === "document" && <rect x="24" y="18" width="160" height="13" rx="4" />}
        {[168, 226, 125, 196, 150, 215, 104].map((width, index) => {
          const inset = kind === "code" ? [0, 20, 40, 20, 40, 20, 0][index]! : 0;
          const y = (kind === "document" ? 56 : 30) + index * 23;
          return <g key={index} opacity={index > 4 ? .5 : 1}>
            {kind === "terminal" && <path d={`M24 ${y} l5 4 -5 4`} fill="none" stroke="currentColor" strokeWidth="2" />}
            <rect x={(kind === "terminal" ? 43 : 24) + inset} y={y} width={width - inset} height="7" rx="3.5" />
          </g>;
        })}
      </>}
    </svg>
  );
}
