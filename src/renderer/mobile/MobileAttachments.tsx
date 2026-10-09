import { useRef } from "react";
import { Images } from '@phosphor-icons/react/dist/csr/Images';
import { findTerminalTextarea } from "./key-bar-keys";

/** Shares the key bar's focus-preserving touch handling. File selections
 * enter TerminalTab's existing drop path, including progress and errors. */
export function MobileAttachments() {
  const photosRef = useRef<HTMLInputElement>(null);
  const targetRef = useRef<HTMLTextAreaElement | null>(null);

  const choose = () => {
    // Capture before opening the native picker: the visible pane can
    // change while it is open, and those files belong to this terminal.
    targetRef.current = findTerminalTextarea();
    if (targetRef.current) photosRef.current?.click();
  };

  const attach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = ""; // Choosing the same photo again still fires change.
    const target = targetRef.current;
    targetRef.current = null;
    if (!target?.isConnected || files.length === 0) return;
    const data = new DataTransfer();
    for (const file of files) data.items.add(file);
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  };

  return (
    <div className="mobile-attachments">
      <button
        type="button"
        className="mobile-key"
        aria-label="Photos"
        onPointerDown={(e) => e.preventDefault()}
        // Cancelled touchstart suppresses iOS's synthetic click. A
        // zero-detail click still serves keyboard and assistive input.
        onPointerUp={(e) => { if (e.button === 0) choose(); }}
        onClick={(e) => { if (e.detail === 0) choose(); }}
      >
        <Images size={16} aria-hidden="true" />
      </button>
      <input ref={photosRef} type="file" accept="image/*" multiple hidden onChange={attach} />
    </div>
  );
}
