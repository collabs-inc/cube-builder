// What the navigator's surfaces mean by "the machine you are looking at":
// the machine the sidebar's switch shows, and the roots a browser would
// open on it.
//
// This file used to be the column browser itself — the Browse group of the
// Computer page, then the Files window of the desktop. The navigator's
// Projects surface shows the machine's own tree instead, so the component
// and the drag starters it handed the browser are gone; what several
// surfaces still share is the context below.
import { createContext, useEffect, useState } from "react";
import { LOCAL_MACHINE_ID, type RepoInfo } from "@port/shared/types";
import { services } from "../services";
import type { LocalComputerInfo } from "../services/types";
import { useRepos } from "../state/repos";
import { type SidebarMachine } from "../state/ui";
import { virtualRootFor } from "../sidebar/group-entries";
import type { BrowserRoot } from "./ColumnBrowser";

/** A swipe page retains its own machine while the shared selection moves. */
export const BrowseMachineContext = createContext<SidebarMachine | null>(null);

/** What this host knows about itself, once. */
export function useLocalInfo(): LocalComputerInfo | null {
  const [info, setInfo] = useState<LocalComputerInfo | null>(null);
  useEffect(() => {
    let live = true;
    void services.computer.localInfo().then(next => { if (live) setInfo(next); }).catch(() => { if (live) setInfo(null); });
    return () => { live = false; };
  }, []);
  return info;
}

/** The machine the sidebar's switch shows, and the roots the browser opens on it. */
export function useBrowseContext(): { machineId: string | null; local: boolean; roots: BrowserRoot[]; repos: RepoInfo[]; homeDir: string | null; info: LocalComputerInfo | null } {
  const local = true;
  const machineId = LOCAL_MACHINE_ID;
  const { repos } = useRepos();
  const info = useLocalInfo();
  const homeDir = local ? info?.homeDir ?? null : null;
  const shownRepos = repos.filter(repo => repo.kind === (local ? "local" : "cloud") && !repo.worktreeOf);
  const roots: BrowserRoot[] = [
    ...(homeDir ? [{ name: "Home", path: homeDir, repoId: null }] : []),
    ...shownRepos.map(repo => ({ name: repo.name, path: virtualRootFor(repo), repoId: repo.id })),
  ];
  return { machineId, local, roots, repos, homeDir, info };
}
