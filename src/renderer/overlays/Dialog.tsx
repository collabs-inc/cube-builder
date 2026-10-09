/**
 * The app's one dialog primitive: shell, header, body, actions row, and —
 * the point of it — a single implementation of the keyboard and focus
 * behaviour every dialog was previously deciding for itself (#58).
 *
 * Before this, six dialogs agreed on almost nothing: five hand-picked
 * widths (240/380/480/560/640), a button class family each, and an
 * accessibility story that was whatever its author remembered. Two of six
 * declared a dialog role; none trapped focus; AddLocalRepoModal's
 * Escape handler never fired at all, because it was bound to a
 * non-focusable <div> in a dialog that focused nothing on open.
 *
 * What the primitive owns, so no caller has to:
 *   - `role` (`dialog`, or `alertdialog` when the dialog reports rather
 *     than asks) plus `aria-modal` and a label wired to the visible title;
 *   - Escape to close, `preventDefault()`d so the narrow sidebar drawer's
 *     document listener does not act on the same press (Sidebar.tsx bails
 *     on `defaultPrevented` — that protocol predates this file);
 *   - focus entry on open, a Tab cycle that cannot leave, and focus
 *     restored to whatever opened the dialog on close;
 *   - one width scale (sm/md/lg) and one actions row.
 *
 * All of the keyboard and focus behaviour now lives in dialog-behavior.ts
 * (#69), so SettingsModal — which needs that behaviour but not this shell —
 * shares this file's stack rather than keeping a second one beside it.
 *
 * Deliberately NOT in packages/components: that package holds content
 * views whose internals call window.api directly, and nothing outside this
 * app needs a dialog shell.
 *
 * GateModal stays as it is by design:
 * it is undismissable on purpose.
 */



import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialogBehavior } from "./dialog-behavior";
import "./Dialog.css";

/** One width scale, replacing the five values that preceded it. */
export type DialogSize = "sm" | "md" | "lg" | "full";

/**
 * Which stack the dialog sits in. `alert` is for dialogs that can be
 * raised from inside another overlay — a confirm launched from Settings
 * has to render above it (see Dialog.css for the z-index ladder).
 */
export type DialogLayer = "base" | "alert";

export interface DialogProps {
  /** Escape and a backdrop click both route here. */
  onClose: () => void;
  /** Visible heading. Also becomes the dialog's accessible name. */
  title?: ReactNode;
  /** Accessible name when the dialog shows no visible title. */
  label?: string;
  /** `alertdialog` for a dialog that reports and demands a response. */
  role?: "dialog" | "alertdialog";
  size?: DialogSize;
  layer?: DialogLayer;
  /**
   * Enter's action, handled at the document level. Opt-in: a dialog whose
   * body has its own Enter semantics (a repo list where Enter activates
   * the focused option) must not have them swallowed here.
   *
   * Fires in the CAPTURE phase regardless of where focus sits inside the
   * dialog — so in a confirm dialog, tabbing to Cancel and pressing Enter
   * still confirms. That overrides the universal native expectation that
   * Enter activates whatever element has focus, so it must never be a
   * surprise: it's deliberate, guaranteeing ConfirmDialog's "Enter
   * confirms wherever focus is" contract rather than a native button-click
   * default.
   */
  onEnter?: () => void;
  /** Identity class for the shell — test/e2e hooks and content rules. */
  className?: string;
  /** Identity class for the backdrop. */
  overlayClassName?: string;
  /** The actions row. Compose it from <DialogButton>. */
  actions?: ReactNode;
  children: ReactNode;
}

export function Dialog({
  onClose,
  title,
  label,
  role = "dialog",
  size = "sm",
  layer = "base",
  onEnter,
  className,
  overlayClassName,
  actions,
  children,
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useDialogBehavior(dialogRef, { onClose, onEnter });

  // Portaled to #overlay-root: .app-body is marked inert while some
  // overlays are up, so a dialog must never be its descendant.
  return createPortal(
    <div
      className={`dialog-overlay dialog-overlay-${layer} app-modal-overlay${size === "full" ? " dialog-overlay-full" : ""}${
        overlayClassName ? ` ${overlayClassName}` : ""
      }`}
      // A backdrop click closes; a click that merely bubbles up from
      // inside the dialog does not.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`dialog dialog-${size}${className ? ` ${className}` : ""}`}
        role={role}
        aria-modal="true"
        aria-labelledby={title !== undefined ? titleId : undefined}
        aria-label={title === undefined ? label : undefined}
        // Focus target of last resort — see initialFocusTarget().
        tabIndex={-1}
      >
        {title !== undefined && (
          <h2 className="dialog-title" id={titleId}>
            {title}
          </h2>
        )}
        <div className="dialog-body">{children}</div>
        {actions !== undefined && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>,
    document.getElementById("overlay-root") ?? document.body,
  );
}

export interface DialogButtonProps {
  children: ReactNode;
  /** Only supply a shortcut the containing dialog actually handles. */
  shortcut?: string;
  onClick: () => void;
  /** `primary` is the dialog's declared default action. */
  variant?: "primary" | "secondary";
  disabled?: boolean;
  /** Takes focus when the dialog opens. */
  autoFocus?: boolean;
  className?: string;
}

/**
 * The actions row's one button. Replaces .confirm-dialog-cancel /
 * .confirm-dialog-confirm / .add-repo-button / .new-worktree-button,
 * which had independently chosen padding, radius and font size.
 */
export function DialogButton({
  children,
  shortcut,
  onClick,
  variant = "secondary",
  disabled,
  autoFocus,
  className,
}: DialogButtonProps) {
  return (
    <button
      type="button"
      className={`dialog-button dialog-button-${variant}${className ? ` ${className}` : ""}`}
      disabled={disabled}
      data-tooltip={shortcut && typeof children === "string" ? children : undefined}
      data-shortcut={shortcut}
      data-dialog-autofocus={autoFocus ? "" : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
