// Adapted from packages/components/src/Editor/EditorConflictBanner.tsx at 600e05f2294df5c71026b723915306a74c8cfd3a.
interface EditorConflictBannerProps {
  onReload: () => void;
  onOverwrite: () => void;
}

export function EditorConflictBanner({
  onReload,
  onOverwrite,
}: EditorConflictBannerProps) {
  return (
    <div className="editor-conflict-banner">
      <span>File changed on disk</span>
      <div className="editor-conflict-banner-actions">
        <button type="button" onClick={onReload}>
          Reload
        </button>
        <button type="button" onClick={onOverwrite}>
          Keep mine
        </button>
      </div>
    </div>
  );
}
