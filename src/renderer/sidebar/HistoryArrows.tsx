// Back and forward over where you have been (state/navigation-history.ts),
// beside the machine switch in the sidebar's titlebar strip.
import { useSyncExternalStore } from "react";
import { CaretLeft } from '@phosphor-icons/react/dist/csr/CaretLeft';
import { CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { back, forward, navigationHistoryStore } from "../state/navigation-history";
import "./HistoryArrows.css";

export function HistoryArrows() {
  const { canBack, canForward } = useSyncExternalStore(navigationHistoryStore.subscribe, navigationHistoryStore.getSnapshot);
  return (
    <span className="history-arrows">
      <button type="button" className="history-arrow" aria-label="Back" title="Back" disabled={!canBack} onClick={back}><CaretLeft size={14} /></button>
      <button type="button" className="history-arrow" aria-label="Forward" title="Forward" disabled={!canForward} onClick={forward}><CaretRight size={14} /></button>
    </span>
  );
}
