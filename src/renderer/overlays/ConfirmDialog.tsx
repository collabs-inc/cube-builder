/**
 * In-app replacement for the native dialog:confirm gate (Electron's
 * dialog.showMessageBox), which couldn't confirm on Enter or dismiss on
 * an outside click. Same contract as the old IPC call: resolves with the
 * index of the pressed button — 0 (cancel) or 1 (confirm) — so callers
 * keep checking `response !== 1`. Enter confirms, Escape or clicking the
 * backdrop cancels. With onConfirm, the request remains open during the
 * operation and resolves 1 only on success; a failure stays visible until
 * dismissed and resolves 0.
 *
 * Imperative promise API over a module store (the workspace.ts
 * subscribe/getSnapshot pattern): callers await confirmDialog(opts);
 * <ConfirmDialogHost /> — mounted once in AppShell — renders whatever
 * request is at the head of the queue.
 *
 * The shell, keyboard handling and focus behaviour come from the Dialog
 * primitive (#58); what is left here is the queue and the promise
 * contract. `layer="alert"` because a confirm can be raised from inside
 * Settings ("Reset machine…") and has to render above it.
 */



import { useEffect, useRef, useSyncExternalStore } from "react";
import { Dialog, DialogButton } from "./Dialog";
import "./ConfirmDialog.css";

export interface ConfirmDialogOptions {
  /** Invalidates this confirmation permanently, including while queued. */
  signal?: AbortSignal;
  message: string;
  detail?: string;
  /** [cancel, confirm] — cancel is always index 0, confirm index 1. */
  buttons: [cancel: string, confirm: string];
  /** Keep the dialog open until this operation completes. Failures show a Close action. */
  onConfirm?: (setProgress: (message: string) => void) => Promise<void>;
  pendingMessage?: string;
  pendingDetail?: string;
}

interface ConfirmRequest extends ConfirmDialogOptions {
  id: number;
  cleanup?: () => void;
  resolve: (response: number) => void;
  phase: "ready" | "pending" | "error";
  progress?: string;
  error?: string;
}

let nextRequestId = 1;
let queue: ConfirmRequest[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ConfirmRequest | null {
  return queue[0] ?? null;
}

export function confirmDialog(opts: ConfirmDialogOptions): Promise<number> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) { resolve(0); return; }
    const request: ConfirmRequest = { ...opts, id: nextRequestId++, resolve, phase: "ready" };
    const abort = () => {
      queue = queue.filter(item => item.id !== request.id);
      request.cleanup?.();
      resolve(0);
      emit();
    };
    opts.signal?.addEventListener("abort", abort, { once: true });
    request.cleanup = () => opts.signal?.removeEventListener("abort", abort);
    queue = [...queue, request];
    emit();
  });
}

function settle(request: ConfirmRequest, response: number): void {
  if (queue[0]?.id !== request.id) return;
  request.cleanup?.();
  queue = queue.slice(1);
  request.resolve(response);
  emit();
}

function close(request: ConfirmRequest): void {
  if (queue[0]?.id !== request.id || queue[0].phase === "pending") return;
  settle(request, 0);
}

function confirm(request: ConfirmRequest): void {
  const current = queue[0];
  // Consult the store, not the rendered snapshot: a second event can arrive
  // before React renders the pending state and disables the buttons.
  if (current?.id !== request.id || current.phase === "pending") return;
  if (current.phase === "error") { settle(current, 0); return; }
  if (!current.onConfirm) { settle(current, 1); return; }

  const onConfirm = current.onConfirm;
  queue = [{ ...current, phase: "pending", progress: current.pendingDetail ?? "Working…" }, ...queue.slice(1)];
  emit();
  // The operation belongs to the queued request, so host unmount/remount
  // neither starts it twice nor loses its eventual completion.
  void (async () => {
    try {
      await onConfirm((message) => {
        const head = queue[0];
        if (head?.id !== current.id || head.phase !== "pending") return;
        queue = [{ ...head, progress: message }, ...queue.slice(1)];
        emit();
      });
      settle(current, 1);
    } catch (error) {
      const head = queue[0];
      if (head?.id !== current.id) return;
      queue = [{ ...head, phase: "error", error: error instanceof Error ? error.message : String(error) }, ...queue.slice(1)];
      emit();
    }
  })();
}

function ConfirmDialogModal({ request }: { request: ConfirmRequest }) {
  const messageRef = useRef<HTMLParagraphElement>(null);
  const pending = request.phase === "pending";
  const failed = request.phase === "error";
  const message = pending ? request.pendingMessage ?? request.message : request.message;

  useEffect(() => {
    const dialog = messageRef.current?.closest<HTMLElement>(".confirm-dialog");
    if (pending) dialog?.focus();
    else if (failed) dialog?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [pending, failed]);

  return (
    <Dialog
      role="alertdialog"
      label={message}
      layer="alert"
      overlayClassName="confirm-dialog-overlay"
      className="confirm-dialog"
      onClose={() => close(request)}
      onEnter={() => confirm(request)}
      actions={
        failed ? <DialogButton shortcut="Enter" variant="primary" autoFocus onClick={() => close(request)}>Close</DialogButton> : <>
          <DialogButton {...(pending ? {} : { shortcut: "Escape" })} disabled={pending} onClick={() => close(request)}>{request.buttons[0]}</DialogButton>
          <DialogButton {...(pending ? {} : { shortcut: "Enter" })} disabled={pending} variant="primary" autoFocus onClick={() => confirm(request)}>
            {request.buttons[1]}
          </DialogButton>
        </>
      }
    >
      <p ref={messageRef} className="confirm-dialog-message">{message}</p>
      {pending ? <div className="confirm-dialog-status" role="status" aria-live="polite">
        <span className="confirm-dialog-spinner" aria-hidden="true" />
        <p className="confirm-dialog-detail">{request.progress}</p>
      </div> : failed ? <p className="confirm-dialog-error" role="alert">{request.error}</p>
        : request.detail !== undefined && <p className="confirm-dialog-detail">{request.detail}</p>}
    </Dialog>
  );
}

export function ConfirmDialogHost() {
  const request = useSyncExternalStore(subscribe, getSnapshot);
  if (!request) return null;
  // Keyed by identity so a queued follow-up request remounts the dialog
  // (fresh keydown effect + focus entry) instead of updating in place.
  return <ConfirmDialogModal key={request.id} request={request} />;
}
