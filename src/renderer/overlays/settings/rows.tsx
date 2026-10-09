/**
 * The settings panel's row vocabulary (#69).
 *
 * The five panes each used to hand-roll their controls with independently
 * chosen inline padding, borders and fills — RadioOption, MachineActionButton,
 * InstallStrip, ThemeToggle, ShortcutList, plus a copy-pasted pane header in
 * all five. Same job, five answers. These are the one answer.
 *
 * A row is two columns: label and optional description on the left, the row's
 * ONE control on the right. Nothing is drawn between rows by default —
 * grouping is a label plus whitespace.
 *
 * `SettingGroup ruled` is the exception, and it exists because the exception
 * turned out to be real: a group of eleven one-line rows (Keyboard Shortcuts)
 * is a table, and a table without rules makes the eye carry a label across
 * the pane to its value unaided. Two or three rows with descriptions under
 * them do not have that problem, so they do not get rules.
 *
 * Local to Settings rather than in packages/components, for the reason
 * Dialog.tsx gives: that package holds content views whose internals call
 * window.api directly, and nothing outside this app needs a settings row.
 */



import type { ReactNode } from "react";
import "./rows.css";

export function PaneHeader({ title, lede }: { title: string; lede?: ReactNode }) {
  return (
    <div className="setting-pane-header">
      <h2 className="setting-pane-title">{title}</h2>
      {lede !== undefined && <p className="setting-pane-lede">{lede}</p>}
    </div>
  );
}

export function SettingGroup({
  label,
  ruled,
  children,
}: {
  label?: string;
  /** Draw a hairline between rows. For tables of one-line rows — see above. */
  ruled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`setting-group${ruled ? " is-ruled" : ""}`}>
      {label !== undefined && <p className="setting-group-label">{label}</p>}
      {children}
    </div>
  );
}

export function SettingRow({
  label,
  description,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <span className="setting-row-label">{label}</span>
        {description !== undefined && (
          <span className="setting-row-description">{description}</span>
        )}
      </div>
      {children !== undefined && <div className="setting-row-control">{children}</div>}
    </div>
  );
}

/**
 * A selectable row for the Terminal pane's harness list — the one pane that
 * keeps an explicit radio list rather than folding into a single control.
 * Its per-option sentences are load-bearing: naming a harness explicitly is
 * how a user asks to be TOLD when it can't be launched, instead of quietly
 * getting a shell, and no single control can carry that per option.
 *
 * `attached` squares the bottom edge for the install strip that joins it —
 * carried over from RadioOption, which documented why: left rounded and
 * transparent, the strip's lighter rectangle shows through the corner notches
 * and reads as a rendering artefact rather than one control.
 */
export function RadioRow({
  selected,
  onClick,
  label,
  description,
  attached = false,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  description?: string;
  attached?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={`setting-radio-row${selected ? " is-selected" : ""}${
        attached ? " is-attached" : ""
      }`}
    >
      <span className="setting-radio-mark" aria-hidden="true" />
      <span className="setting-row-text">
        <span className="setting-row-label">{label}</span>
        {description && <span className="setting-row-description">{description}</span>}
      </span>
      {children !== undefined && <span className="setting-row-control">{children}</span>}
    </button>
  );
}

export function SettingAction({
  children,
  onClick,
  disabled,
  destructive,
}: {
  children: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`setting-action${destructive ? " is-destructive" : ""}`}
    >
      {children}
    </button>
  );
}

/** An on/off setting: the row's one control when the row IS the setting. */
export function SettingSwitch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The accessible name; the row's visible label says the same thing. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="setting-switch"
    >
      <span className="setting-switch-knob" aria-hidden="true" />
    </button>
  );
}

/** A pane's own status or failure line, under the row that produced it. */
export function SettingNote({ children, isError }: { children: ReactNode; isError?: boolean }) {
  return <p className={`setting-note${isError ? " is-error" : ""}`}>{children}</p>;
}
