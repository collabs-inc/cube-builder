export interface CubedManifest {
  bundleId: string;
  build: number;
  cubedInterface: number;
  ptydInterface: number;
  externalDeps: string[];
  version?: string;
  release?: true;
}

/** Accepts legacy and release manifests, ignoring unknown fields. */
export function parseManifest(raw: unknown): CubedManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const m = raw as Record<string, unknown>;
  const cubedInterface = m.cubedInterface === undefined ? 0 : m.cubedInterface;
  if (
    typeof m.bundleId !== "string" || m.bundleId === "" ||
    typeof m.build !== "number" || !Number.isInteger(m.build) ||
    typeof cubedInterface !== "number" || !Number.isInteger(cubedInterface) ||
    typeof m.ptydInterface !== "number" || !Number.isInteger(m.ptydInterface) ||
    !Array.isArray(m.externalDeps) || !m.externalDeps.every(d => typeof d === "string")
  ) return null;
  return {
    bundleId: m.bundleId,
    build: m.build,
    cubedInterface,
    ptydInterface: m.ptydInterface,
    externalDeps: m.externalDeps,
    ...(typeof m.version === "string" ? { version: m.version } : {}),
    ...(m.release === true ? { release: true as const } : {}),
  };
}

export function isReleaseManifest(m: CubedManifest): boolean {
  return m.release === true;
}
