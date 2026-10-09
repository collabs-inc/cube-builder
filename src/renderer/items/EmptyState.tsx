// What the rail shows whenever it has no columns — either no items are
// open at all, or every open item is hidden. Hidden items may still exist
// (and remain listed in the sidebar); this only reflects the layout.
//
// No narrow variant: the narrow projection (state/ui.ts's
// `effectiveNarrowView`) sends a viewport with no active item to the home
// screen (mobile/MobileHome.tsx) before the rail's own empty state could
// ever show, since a fresh columns-less arrangement has no active item
// either. That home list is also the browse-repos affordance this
// component's old narrow branch used to provide.
import { PrismMark } from "../sidebar/prism-mark";
import { EmptyQuickActions } from "./EmptyQuickActions";
export function EmptyState({ screenId }: { screenId?: string | undefined; visible?: boolean }) {
  return (
    <div className="app-empty-state">
      <div className="empty-actions-anchor">
        <PrismMark size={76} className="app-empty-state-mark" />
        <EmptyQuickActions screenId={screenId} />
      </div>
    </div>
  );
}

export default EmptyState;
