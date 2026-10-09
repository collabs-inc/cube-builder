import { useEffect, useState } from "react";
import { AGENT_CATALOG, agentTargetId } from "@port/shared/agent-catalog";
import { Sparkle } from '@phosphor-icons/react/dist/csr/Sparkle';
import { FolderPlus } from '@phosphor-icons/react/dist/csr/FolderPlus';
import { Terminal } from '@phosphor-icons/react/dist/csr/Terminal';
import { LOCAL_MACHINE_ID } from "@port/shared/types";
import { services } from "../services";
import { useCatalog } from "../state/catalog";

import { repoViewFrom } from "../state/repo-views";
import { activeCheckoutId, focusItem, screenView, setActiveView, useWorkspace, type WorkspaceState } from "../state/workspace";
import { checkoutName, virtualRootFor } from "../sidebar/group-entries";
import type { OwnedRepo } from "@port/shared/catalog";
import CreateRepoModal from "../sidebar/CreateRepoModal";
import AddLocalRepoModal from "../sidebar/AddLocalRepoModal";
import { chooseRepoAction } from "../sidebar/choose-repo-action";
import { isInstallationMachine } from "../services/machine";
import { createTerminalItem } from "./TerminalItem";
import { openShellAtHome } from "./run-command-in-terminal";
import { getDefaultAgent } from "./agent/default-agent";
import { launchFailureMessage } from "./terminal-item-logic";
import "./EmptyQuickActions.css";

/** The ready checkout this screen (else the active screen) is scoped to, if any. */
function agentCheckout(workspace: WorkspaceState, repos: readonly OwnedRepo[], screenId: string | undefined): OwnedRepo | null {
  const screen = screenId ? workspace.screens.find(s => s.id === screenId) : undefined;
  const checkoutId = screen ? screen.checkoutId ?? null : activeCheckoutId(workspace);
  const checkout = repos.find(repo => repo.id === checkoutId) ?? null;
  return checkout && !checkout.worktreeOf?.creation ? checkout : null;
}

/** "repo" for a main checkout, "repo / worktree" for a linked one. */
function checkoutLabel(checkout: OwnedRepo, repos: readonly OwnedRepo[]): string {
  if (!checkout.worktreeOf) return checkout.name;
  const root = repos.find(repo => repo.id === checkout.worktreeOf!.repoId);
  return `${root?.name ?? checkout.name} / ${checkoutName(repoViewFrom(checkout))}`;
}

export function EmptyQuickActions({ screenId }: { screenId?: string | undefined }) {
  const catalog = useCatalog();
  const workspace = useWorkspace();
  const checkout = agentCheckout(workspace, catalog.repos, screenId);
  const [defaultAgentName, setDefaultAgentName] = useState("");
  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      void getDefaultAgent().then(target => {
        if (mounted) setDefaultAgentName(AGENT_CATALOG.find(agent => agentTargetId(agent) === target)?.name ?? target);
      }).catch(() => {});
    };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 2000);
    return () => { mounted = false; window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, []);
  const [machine, setMachine] = useState<string | null>(null);
  const [existingMachine, setExistingMachine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); } catch (cause) { setError(launchFailureMessage(cause)); }
    finally { setBusy(false); }
  };
  // Unscoped screens pick a main checkout; any worktree is the agent's to make.
  const pick = async () => {
    const repos = catalog.repos.filter(repo => !repo.worktreeOf);
    if (!repos.length) { setError("Create a repo first to get started."); return null; }
    const id = await services.desktop.showContextMenu(repos.map(repo => ({ id: repo.id,
      label: `${repo.name} · ${repo.machineId === LOCAL_MACHINE_ID ? "Local" : "Cloud"}`,
    })));
    return repos.find(repo => repo.id === id) ?? null;
  };
  // In the screen's checkout when it has one, so the label below is what happens.
  const newAgent = () => run(async () => {
    const repo = checkout ?? await pick();
    if (!repo || !isInstallationMachine(repo.machineId)) return;
    const item = await createTerminalItem({
      machineId: repo.machineId, repoId: repo.id, cwd: virtualRootFor(repoViewFrom(repo)),
      target: await getDefaultAgent(), view: "conversation",
    });
    if (screenId) setActiveView(screenView(screenId));
    focusItem(item.id, item.type, repo.id);
  });
  // A plain shell on the cloud machine, at its home: no repo to pick first.
  const openTerminal = () => run(async () => {
    if (screenId) setActiveView(screenView(screenId));
    await openShellAtHome(LOCAL_MACHINE_ID);
  });
  const newRepo = () => run(async () => {
    const id = LOCAL_MACHINE_ID;
    const action = await chooseRepoAction(id);
    if (action === "create-repo") setMachine(id);
    if (action === "add-existing-repo") setExistingMachine(id);
  });
  const agentName = defaultAgentName || "Default agent";
  const agentDetail = checkout ? `${agentName} in ${checkoutLabel(checkout, catalog.repos)}` : `${agentName} · choose a repo`;
  return <>
    <div className="empty-quick-actions" aria-label="Quick actions">
      <button className="empty-quick-action" disabled={busy} onClick={() => void newRepo()}><FolderPlus size={22} /><span>Add Repo</span><small>Create or clone project</small></button>
      <button className="empty-quick-action" disabled={busy} onClick={() => void newAgent()}><Sparkle size={22} /><span>New Agent</span><small>{agentDetail}</small></button>
      <button className="empty-quick-action" disabled={busy} onClick={() => void openTerminal()}><Terminal size={22} /><span>Open Terminal</span><small>~ on this machine</small></button>
    </div>
    {error && <p className="app-empty-state-copy" role="alert">{error}</p>}
    {machine && <CreateRepoModal machineId={machine} onClose={() => setMachine(null)} />}
    <AddLocalRepoModal open={existingMachine === LOCAL_MACHINE_ID} onClose={() => setExistingMachine(null)} />
  </>;
}
