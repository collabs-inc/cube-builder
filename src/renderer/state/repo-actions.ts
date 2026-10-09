/** User-initiated repo additions share the worktree's first-session behavior. */



import type { CreateRepoArgs } from "@port/shared/repo-create";



import { services } from "../services";
import { trackCreatedRepo } from "./repo-ready";


export async function addLocalRepo() {
  const result = await services.repos.add();
  if (result) trackCreatedRepo(result.repo.id);
  return result;
}

export async function createRepo(machineId: string, args: CreateRepoArgs) {
  const result = await services.repos.create(machineId, args);
  trackCreatedRepo(result.repo.id);
  return result;
}

