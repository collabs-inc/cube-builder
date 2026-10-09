// A screen's layout in miniature: its columns and panes as proportioned
// blocks, extracted from the screen strip's unnamed tab so any other
// surface that wants one draws the same thing; the caller sizes the box,
// this fills it.
import type { Screen } from "../state/screen-ops";

export function ScreenLayoutMiniature({
  screen,
  className = "view-switcher-layout",
}: {
  screen: Screen;
  className?: string;
}) {
  return (
    <span className={className} aria-hidden="true"
      style={{ gridTemplateColumns: screen.columns.map(column => `${column.widthRatio}fr`).join(" ") }}>
      {screen.columns.map(column => (
        <span key={column.id} className={`${className}-column`}
          style={{ gridTemplateRows: column.panes.map(pane => `${pane.heightRatio}fr`).join(" ") }}>
          {column.panes.map(pane => <span key={pane.itemId} className={`${className}-tile`} />)}
        </span>
      ))}
    </span>
  );
}
