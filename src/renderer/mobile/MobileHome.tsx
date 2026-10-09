/**
 * Studio's phone project list — the list-first narrow projection's "home"
 * (docs/superpowers/specs/2026-09-01-mobile-list-first-design.md).
 *
 * Deliberately a thin wrapper around ReposSidebar rather than a new list:
 * that component already owns every management verb (new terminal/agent,
 * new/remove worktree, clone/remove repo, close, rename) plus the
 * catalog/live-status row model, and rebuilding any of it would fork the
 * verbs the spec says to reuse. What this file adds is a full-viewport,
 * safe-area-padded host and the one wiring decision: a row navigation
 * means "show the item screen". No chrome of its own — an identity header
 * ("Cube" + mark) was here once and the user cut it: on a phone every
 * vertical pixel belongs to the list, and the brand says nothing the app
 * icon didn't.
 *
 * Settings is NOT duplicated here: ReposSidebar renders SidebarFooter,
 * whose gear is the app-wide settings entry on every width.
 *
 * `visible` mirrors Sidebar.tsx's keep-both-panels-mounted pattern: while
 * the item screen shows, this stays mounted at display:none so scroll
 * position and in-flight modals survive, and ReposSidebar's document-level
 * key handlers stand down via its own `visible` prop.
 */
import "./MobileHome.css";
import { ReposSidebar } from "../sidebar/ReposSidebar";
import { setNarrowView } from "../state/ui";

/** Exported for MobileHome.test.tsx — the row-navigation wiring itself. */
export function onNavigateToItem(): void {
  setNarrowView("item");
}

export function MobileHome({ visible }: { visible: boolean }) {
  return (
    <div className={visible ? "mobile-home" : "mobile-home mobile-home-hidden"} inert={!visible}>
      <div className="mobile-home-list">
        <ReposSidebar
          visible={visible}
          onNavigate={onNavigateToItem}
          touchRows
          layout="mini"
        />
      </div>
    </div>
  );
}

export default MobileHome;
