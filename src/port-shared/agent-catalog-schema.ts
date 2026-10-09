export interface AgentInstallation {
  readonly commands: readonly string[];
  readonly startCommand: string;
  readonly notes: string;
  readonly setupUrl: string;
  readonly platforms: readonly ("macos" | "linux")[];
}

export interface AgentUninstall {
  readonly commands: readonly string[];
  readonly url: string;
  readonly note?: string;
}

export interface AgentCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly maker: string;
  readonly description: string;
  readonly url: string;
  readonly iconUrl: string;
  readonly installation: AgentInstallation;
  readonly uninstall: AgentUninstall;
  readonly kind?: string;
  readonly integratedHarness?: "claude" | "codex" | "opencode";
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const HARNESSES = new Set(["claude", "codex", "opencode"]);
const PLATFORMS = new Set(["macos", "linux"]);
const https = (v: unknown): v is string => typeof v === "string" && /^https:\/\/\S+$/.test(v);
const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export function parseAgentCatalog(value: unknown): readonly AgentCatalogEntry[] {
  const problems: string[] = [];
  const bad = (path: string, why: string) => { problems.push(`${path}: ${why}`); };
  const root = value as { schemaVersion?: unknown; agents?: unknown };
  if (!root || typeof root !== "object") throw new Error("catalog: must be an object");
  if (root.schemaVersion !== 1) bad("schemaVersion", "must be 1");
  if (!Array.isArray(root.agents)) { bad("agents", "must be an array"); throw new Error(problems.join("\n")); }
  const ids = new Set<string>();
  const out: AgentCatalogEntry[] = [];
  root.agents.forEach((raw: Record<string, unknown>, i) => {
    const p = `agents[${i}]`;
    // A null or non-object entry used to throw a raw TypeError off the first
    // property read, which names neither the file nor the index. Report it
    // like every other problem and carry on validating the rest.
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) { bad(p, "must be an object"); return; }
    if (!str(raw.id) || !ID.test(raw.id)) bad(`${p}.id`, "lowercase letters, digits and hyphens");
    else if (ids.has(raw.id)) bad(`${p}.id`, `duplicate id ${raw.id}`); else ids.add(raw.id);
    for (const f of ["name", "maker", "description"]) if (!str(raw[f])) bad(`${p}.${f}`, "required");
    for (const f of ["url", "iconUrl"]) if (!https(raw[f])) bad(`${p}.${f}`, "must be an https: URL");
    if (raw.kind !== undefined && !str(raw.kind)) bad(`${p}.kind`, "must be a string");
    if (raw.integratedHarness !== undefined && !HARNESSES.has(raw.integratedHarness as string)) bad(`${p}.integratedHarness`, "must be claude, codex or opencode");
    const inst = raw.installation as Record<string, unknown> | undefined;
    if (!inst || typeof inst !== "object") bad(`${p}.installation`, "required");
    else {
      if (!Array.isArray(inst.commands) || inst.commands.length === 0 || !inst.commands.every(str)) bad(`${p}.installation.commands`, "non-empty list of commands");
      if (!str(inst.startCommand) || !(inst.startCommand as string).trim().split(/\s+/)[0]) bad(`${p}.installation.startCommand`, "required");
      if (!str(inst.notes)) bad(`${p}.installation.notes`, "required");
      if (!https(inst.setupUrl)) bad(`${p}.installation.setupUrl`, "must be an https: URL");
      if (!Array.isArray(inst.platforms) || inst.platforms.length === 0 || !inst.platforms.every(x => PLATFORMS.has(x as string))) bad(`${p}.installation.platforms`, "macos and/or linux");
    }
    const un = raw.uninstall as Record<string, unknown> | undefined;
    if (!un || typeof un !== "object") bad(`${p}.uninstall`, "required");
    else {
      if (!Array.isArray(un.commands) || un.commands.length === 0 || !un.commands.every(str)) bad(`${p}.uninstall.commands`, "non-empty list of commands");
      if (!https(un.url)) bad(`${p}.uninstall.url`, "must be an https: URL");
      if (un.note !== undefined && !str(un.note)) bad(`${p}.uninstall.note`, "must be a string");
    }
    out.push(raw as unknown as AgentCatalogEntry);
  });
  if (problems.length) throw new Error(`agent catalog is invalid:\n${problems.join("\n")}`);
  return out;
}
