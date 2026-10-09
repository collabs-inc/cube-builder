import { useEffect, useRef, useState } from "react";
import type { CatalogRepo } from "@port/shared/catalog";
import { LOCAL_MACHINE_ID } from "@port/shared/types";
import { repoSlug, validRepoName, validGithubTarget, type GithubOwner } from "@port/shared/repo-create";
import { services } from "../services";
import { createRepo } from "../state/repo-actions";
import { Dialog, DialogButton } from "../overlays/Dialog";
import "./CreateRepoModal.css";

interface Props {
  machineId: string;
  repo?: Pick<CatalogRepo, "id" | "name" | "githubPublish">;
  onClose(): void;
  onCreated?(repo: CatalogRepo): void;
}

/** Mounted only while open. Keeping the created row inside the dialog
 * makes publication retry independent of checkout creation. */
export default function CreateRepoModal({ machineId, repo, onClose, onCreated }: Props) {
  const [name, setName] = useState(repo?.name ?? "");
  const [publish, setPublish] = useState(Boolean(repo));
  const [githubName, setGithubName] = useState(repo?.githubPublish?.name ?? repoSlug(repo?.name ?? ""));
  const [githubNameEdited, setGithubNameEdited] = useState(false);
  const [owner, setOwner] = useState(repo?.githubPublish?.owner ?? "");
  const [owners, setOwners] = useState<GithubOwner[]>([]);
  const [visibility, setVisibility] = useState<"private" | "public">(repo?.githubPublish?.visibility ?? "private");
  const [created, setCreated] = useState<Pick<CatalogRepo, "id" | "name"> | null>(repo ?? null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useExisting, setUseExisting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const running = useRef(false);
  const local = machineId === LOCAL_MACHINE_ID;

  useEffect(() => {
    if (!publish) return;
    let cancelled = false;
    setLoading(true);
    setAuthError(null);
    void services.repos.githubOwners(machineId).then(result => {
      if (cancelled) return;
      setOwners(result.owners);
      setOwner(current => current || result.owners[0]?.login || "");
    }).catch(err => {
      if (!cancelled) setAuthError(err instanceof Error ? err.message : String(err));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [publish, machineId, refresh]);

  const valid = (created || validRepoName(name)) && (!publish || (!loading && !authError && validGithubTarget({ owner, name: githubName, visibility })));
  async function submit() {
    if (!valid || running.current) return;
    running.current = true;
    setPending(true);
    setError(null);
    let current = created;
    try {
      if (!current) {
        const result = await createRepo(machineId, { name: name.trim() });
        current = result.repo;
        setCreated(current);
        onCreated?.(result.repo);
      }
      if (publish) await services.repos.publish(machineId, { repoId: current.id, owner, name: githubName, visibility, ...(useExisting ? { useExisting: true } : {}) });
      onClose();
    } catch (err) {
      setError(`${current && !repo ? "Repo created. Publishing failed: " : ""}${err instanceof Error ? err.message : String(err)}`);
    } finally { running.current = false; setPending(false); }
  }

  return <Dialog title={repo ? "Publish to GitHub" : "Create repo"} size="md" className="create-repo-modal"
    onClose={() => { if (!running.current) onClose(); }}
    actions={<>
      <DialogButton shortcut="Escape" disabled={pending} onClick={onClose}>{created && !repo ? "Keep repo without publishing" : "Cancel"}</DialogButton>
      <DialogButton variant="primary" disabled={!valid || pending} onClick={() => void submit()}>
        {pending ? (created ? "Publishing…" : "Creating…") : created ? "Publish" : publish ? "Create and publish" : "Create repo"}
      </DialogButton>
    </>}>
    {!repo && <label className="create-repo-field">Name
      <input autoFocus value={name} disabled={pending || Boolean(created)} placeholder="my-project"
        onChange={event => { setName(event.target.value); if (!githubNameEdited) setGithubName(repoSlug(event.target.value)); }}
        onKeyDown={event => { if (event.key === "Enter") void submit(); }} />
    </label>}
    <p className="add-repo-note">{repo ? `Publish committed work from ${repo.name}. Uncommitted files stay on this machine.`
      : "Creates a Git repo on this machine. You can publish to GitHub whenever you're ready."}</p>
    {!repo && <label className="create-repo-toggle"><input type="checkbox" checked={publish} disabled={pending || Boolean(created)} onChange={event => setPublish(event.target.checked)} />Publish to GitHub</label>}
    {publish && <div className="create-repo-github">
      {loading && <p className="add-repo-note" role="status">Loading GitHub accounts…</p>}
      {authError && <div className="create-repo-connection">
        <p className="add-repo-error" role="alert">{authError === "not signed in" ? "Connect GitHub on this machine to publish." : authError}</p>
        <p className="add-repo-note">Run <code>gh auth login</code> in a terminal on this machine, then retry.</p>
        <DialogButton onClick={() => setRefresh(value => value + 1)}>Retry GitHub connection</DialogButton>
      </div>}
      <label className="create-repo-field">Owner
        <select aria-label="Owner" value={owner} disabled={pending || loading} onChange={event => { setOwner(event.target.value); setUseExisting(false); }}>
          {!owners.length && <option value="">Choose an account or organization</option>}
          {owners.map(item => <option key={item.login} value={item.login}>{item.login}{item.kind === "organization" ? " · Organization" : ""}</option>)}
        </select>
      </label>
      <label className="create-repo-field">GitHub repo name
        <input value={githubName} disabled={pending} onChange={event => { setGithubNameEdited(true); setGithubName(event.target.value); setUseExisting(false); }} />
      </label>
      <label className="create-repo-field">Visibility
        <select aria-label="Visibility" value={visibility} disabled={pending} onChange={event => { setVisibility(event.target.value as "private" | "public"); setUseExisting(false); }}>
          <option value="private">Private — only people you invite</option>
          <option value="public">Public — anyone can see it</option>
        </select>
      </label>
      <p className="add-repo-note">Creates the GitHub repo and pushes the current branch once.</p>
    </div>}
    {error && <p className="add-repo-error" role="alert">{error}</p>}
    {error && created && publish && <label className="create-repo-toggle"><input type="checkbox" checked={useExisting} disabled={pending} onChange={event => setUseExisting(event.target.checked)} />
      If {owner}/{githubName} already exists on GitHub, connect it and push my current branch when I retry.
    </label>}
  </Dialog>;
}
