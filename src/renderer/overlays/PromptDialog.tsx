/**
 * A one-field inline prompt: a commit message, a branch name, a pull request
 * title. Same shape as ConfirmDialog — a module queue plus an imperative
 * promise, rendered by a host mounted once in AppShell — because the callers
 * are context menus and toolbar buttons that have nowhere to put a form, and
 * none of these actions is worth a pane.
 *
 * Resolves the TRIMMED value, or null when the user cancels or leaves it
 * empty: an empty commit message is a cancellation, not an operation.
 */



import { useState, useSyncExternalStore } from "react";
import { Dialog, DialogButton } from "./Dialog";
import "./PromptDialog.css";

export interface PromptDialogOptions {
  message: string;
  detail?: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  confirm: string;
}

interface PromptRequest extends PromptDialogOptions {
  id: number;
  resolve: (value: string | null) => void;
}

let nextRequestId = 1;
let queue: PromptRequest[] = [];
const listeners = new Set<() => void>();

const emit = (): void => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = (): PromptRequest | null => queue[0] ?? null;

export function promptDialog(opts: PromptDialogOptions): Promise<string | null> {
  return new Promise(resolve => {
    queue = [...queue, { ...opts, id: nextRequestId++, resolve }];
    emit();
  });
}

function settle(request: PromptRequest, value: string | null): void {
  if (queue[0]?.id !== request.id) return;
  queue = queue.slice(1);
  request.resolve(value);
  emit();
}

function PromptDialogModal({ request }: { request: PromptRequest }) {
  const [value, setValue] = useState(request.initialValue ?? "");
  const submit = (): void => settle(request, value.trim() === "" ? null : value.trim());
  return (
    <Dialog
      role="dialog"
      label={request.message}
      layer="alert"
      overlayClassName="prompt-dialog-overlay"
      className="prompt-dialog"
      onClose={() => settle(request, null)}
      onEnter={submit}
      actions={<>
        <DialogButton shortcut="Escape" onClick={() => settle(request, null)}>Cancel</DialogButton>
        <DialogButton shortcut="Enter" variant="primary" onClick={submit}>
          {request.confirm}
        </DialogButton>
      </>}
    >
      <p className="prompt-dialog-message">{request.message}</p>
      {request.detail !== undefined && <p className="prompt-dialog-detail">{request.detail}</p>}
      <label className="prompt-dialog-label">
        <span className="prompt-dialog-label-text">{request.label}</span>
        <input className="prompt-dialog-input" type="text" value={value}
          placeholder={request.placeholder} data-dialog-autofocus=""
          onChange={event => setValue(event.currentTarget.value)} />
      </label>
    </Dialog>
  );
}

export function PromptDialogHost() {
  const request = useSyncExternalStore(subscribe, getSnapshot);
  if (!request) return null;
  return <PromptDialogModal key={request.id} request={request} />;
}
