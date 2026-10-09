export interface CreateRepoArgs { name: string }
export interface PublishRepoArgs {
  repoId: string;
  owner: string;
  name: string;
  visibility: "private" | "public";
  /** Explicit recovery after remote creation succeeded but its reply was lost. */
  useExisting?: boolean;
}
export interface GithubOwner { login: string; kind: "user" | "organization" }
export interface GithubOwnersResult { owners: GithubOwner[] }
export interface PublishRepoResult { url: string }

export function repoSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "").slice(0, 100);
}

export function validRepoName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0 && name.length <= 100
    && !/[\\/]/.test(name) && [...name].every(char => char.charCodeAt(0) >= 32) && repoSlug(name).length > 0;
}

export function validGithubTarget(args: Pick<PublishRepoArgs, "owner" | "name" | "visibility">): boolean {
  return typeof args.owner === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(args.owner)
    && typeof args.name === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(args.name)
    && args.name !== "." && args.name !== ".." && !args.name.endsWith(".git")
    && (args.visibility === "private" || args.visibility === "public");
}
