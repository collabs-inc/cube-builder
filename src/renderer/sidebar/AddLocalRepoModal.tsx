// New Repo modal for "This Mac": picks a local repository folder via the
// native folder dialog.
//
// The shell comes from the Dialog primitive (#58), which is also what
// finally gives this dialog working keyboard behaviour: it used to bind
// Escape to a non-focusable <div> and autofocus nothing, so the key never
// reached the handler and Escape simply did not close it.
import { useState } from "react";
import { Dialog, DialogButton } from "../overlays/Dialog";
import { addLocalRepo } from "../state/repo-actions";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function AddLocalRepoModal({ open, onClose }: Props) {
  const [pending, setPending] = useState(false);

  if (!open) return null;

  function close(): void {
    onClose();
  }

  async function chooseLocalFolder(): Promise<void> {
    // repo:add both picks the folder and registers it in one round trip
    // — a non-repo selection is rejected with a native dialog on the
    // main-process side (see ipc-workspace.ts's pickAndAddRepo), so
    // there's nothing left for this modal to validate or show inline.
    // Returns null on cancel or on a rejected selection (dialog already
    // shown); otherwise the added repo, even for a tolerated
    // duplicate — either way the modal is done.
    setPending(true);
    try {
      const result = await addLocalRepo();
      if (result) close();
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      title="Add existing repo"
      overlayClassName="add-repo-overlay"
      className="add-repo-modal"
      onClose={close}
      actions={
        <>
          <DialogButton shortcut="Escape" onClick={close}>Cancel</DialogButton>
          <DialogButton
            variant="primary"
            autoFocus
            disabled={pending}
            onClick={() => void chooseLocalFolder()}
          >
            {pending ? "Choosing…" : "Choose folder…"}
          </DialogButton>
        </>
      }
    >
      <p className="add-repo-note">
        A repo on this Mac — pick a folder. Its files and terminals stay on this machine.
      </p>
    </Dialog>
  );
}
