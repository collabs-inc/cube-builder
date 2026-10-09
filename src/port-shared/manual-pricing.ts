export interface ResourceSpecs {
  cpuKind: "shared" | "performance";
  cpus: number;
  memoryMb: number;
  storageGb: number;
}

export interface FormulaPrice {
  computeHourly: string; storageMonthly: string; costMonthly: string;
  subsidyBasisPoints: number; formulaVersion: string;
}
export type ResourcePrice = FormulaPrice;
export function samePrice(a: ResourcePrice, b: ResourcePrice): boolean {
  return a.computeHourly === b.computeHourly && a.storageMonthly === b.storageMonthly
    && a.costMonthly === b.costMonthly && a.subsidyBasisPoints === b.subsidyBasisPoints
    && a.formulaVersion === b.formulaVersion;
}
export interface ResourceCatalog {
  version: string;
  cpuKind: "performance";
  combinations: Array<{ cpus: number; memoryMb: number }>;
  storageStepsGb: number[];
  defaults: ResourceSpecs;
  formulaVersion: string;
  minTopupCents: number;
  maxTopupCents: number;
}
export interface ResourceQuote {
  id: string; ownerId: string; machineId: string | null;
  revision: string; catalogVersion: string; expiresAt: string;
  specs: ResourceSpecs; price: ResourcePrice;
}
export type ManualPhase = "paused" | "starting" | "running" | "pausing" | "updating" | "attention";
export interface ManualSummary {
  mode: "prepaid_manual"; version: 2; revision: string;
  desired: "running" | "paused"; phase: ManualPhase;
  reason: "user" | "credit" | "unexpected-stop" | "repair" | null;
  machineId: string | null; specs: ResourceSpecs | null;
  price: ResourcePrice | null; balanceMicroUsd: string;
  pendingConfiguration?: { specs: ResourceSpecs; price: ResourcePrice } | null;
  remainingSeconds: number | null;
  recoveryHold: boolean; operationId: string | null;
  /** When the machine was last confirmed running; meaningful only while `phase` is running. */
  runningSince?: string | null;
  catalog: ResourceCatalog | null;
  starter: "unclaimed" | "claimed";
  /** A running credit sale; absent or null when none. The backend fixes the price; clients only display it. */
  sale?: CreditSale | null;
  autoTopup: { enabled: boolean; thresholdCents: number; amountCents: number;
    version: string; paymentMethodLabel: string | null; attemptId?: string | null;
    state: "off" | "ready" | "pending" | "action-required" };
}
/** A credit sale: manual top-ups cost `percentOff` less, on up to `remainingCapCents` of face value (null is uncapped). */
export interface CreditSale { label: string; percentOff: number; endsAt: string; capCents: number | null; remainingCapCents: number | null }
/** What a manual top-up of `cents` credit costs under `sale`. Mirrors `manual_create_payment`, which is the authority. */
export function salePriceCents(cents: number, sale: CreditSale | null | undefined): number {
  if (!sale) return cents;
  const covered = Math.min(cents, sale.remainingCapCents ?? cents);
  if (covered <= 0) return cents;
  return Math.max(Math.min(cents, 50), cents - Math.floor(covered * sale.percentOff / 100));
}
/** Whether saving auto-pay with this threshold charges the card at once: the
 * machine is running, credit is already below the threshold, a card is saved and
 * no attempt is pending or latched. Client and API share this so the confirmation
 * a user reads matches what the save does. */
export function autoTopupDueNow(
  summary: Pick<ManualSummary, "phase" | "desired" | "recoveryHold" | "balanceMicroUsd" | "autoTopup">,
  thresholdCents: number = summary.autoTopup.thresholdCents,
): boolean {
  const { autoTopup } = summary;
  return summary.phase === "running" && summary.desired === "running" && !summary.recoveryHold &&
    autoTopup.paymentMethodLabel !== null && autoTopup.state !== "pending" &&
    autoTopup.state !== "action-required" && BigInt(summary.balanceMicroUsd) < BigInt(thresholdCents) * 10000n;
}
export type ManualCommand =
  | { action: "start"; requestId: string; revision: string }
  | { action: "pause"; requestId: string }
  | { action: "configure"; requestId: string; quoteId: string; revision: string; restart: boolean };
export type ManualAction = ManualCommand
  | { action: "status" }
  | { action: "quote"; specs: ResourceSpecs }
  | { action: "topup"; requestId: string; cents: number; saveCard?: boolean }
  | { action: "payment-method"; requestId: string }
  | { action: "auto-topup"; requestId: string; settingsVersion: string; enabled: boolean; thresholdCents: number; amountCents: number }
  | { action: "retry-topup"; requestId: string; attemptId: string }
  | { action: "history"; before: string | null };
export interface CreditEvent { id: string; at: string; amountMicroUsd: string; kind: string }
/** One UTC day of the statement: a line per meter, credits itemised. Amounts are micro-USD strings. */
export interface StatementDay {
  date: string; computeMicroUsd: string; computeMinutes: number; storageMicroUsd: string; storageGb: number; credits: CreditEvent[];
}
export type ManualStatusResult = ManualSummary | { mode: "legacy" };
export type ManualResult = ManualStatusResult | ResourceQuote | { url: string } | { days: StatementDay[]; next: string | null };
export interface AutoTopupAttempt {
  id: string; owner: string; customer: string; paymentMethod: string; cents: number;
  settingsVersion: string; episode: string; paymentIntentId: string | null;
  status: "claimed" | "submitted" | "processing" | "succeeded" | "failed" | "requires-action" | "canceled";
  createdAt: string;
}

const MAX_MONEY = BigInt(Number.MAX_SAFE_INTEGER);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const resourceInteger = (value: unknown): value is number =>
  positiveInteger(value) && value <= 2_147_483_647;
const money = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= MAX_MONEY;
const fail = (code: string): never => { throw new Error(code); };

/** Fly's performance presets, performance-1x through performance-16x; no other core count exists. */
export const FLY_PERFORMANCE_CPUS: readonly number[] = [1, 2, 4, 6, 8, 10, 12, 14, 16];
/** A Fly volume cannot exceed 500 GB, so no catalog may offer more. */
export const FLY_VOLUME_MAX_GB = 500;
const memoryAllowed = (cpus: number, memoryMb: number) =>
  FLY_PERFORMANCE_CPUS.includes(cpus) && memoryMb % 2048 === 0 && memoryMb >= 2048 * cpus && memoryMb <= 8192 * cpus;

export function validateCatalog(value: unknown): ResourceCatalog {
  if (!record(value) || typeof value.version !== "string" || !value.version.trim() || value.cpuKind !== "performance"
    || typeof value.formulaVersion !== "string" || !formulaFor(value.formulaVersion)
    || !Array.isArray(value.combinations) || value.combinations.length === 0
    || !Array.isArray(value.storageStepsGb) || value.storageStepsGb.length === 0
    || !record(value.defaults) || !positiveInteger(value.minTopupCents) || !positiveInteger(value.maxTopupCents)
    || value.maxTopupCents < value.minTopupCents) fail("catalog_unavailable");
  const catalog = value as Record<string, unknown>;
  const combinations = catalog.combinations as unknown[];
  const steps = catalog.storageStepsGb as unknown[];
  if (combinations.some((entry) => !record(entry) || !resourceInteger(entry.cpus) || !resourceInteger(entry.memoryMb)
      || !memoryAllowed(entry.cpus as number, entry.memoryMb as number))
    || new Set(combinations.map((entry) => `${(entry as Record<string, unknown>).cpus}:${(entry as Record<string, unknown>).memoryMb}`)).size !== combinations.length
    || steps.some((step) => !resourceInteger(step) || (step as number) > FLY_VOLUME_MAX_GB) || new Set(steps).size !== steps.length) fail("catalog_unavailable");
  const defaults = catalog.defaults as Record<string, unknown>;
  if (defaults.cpuKind !== "performance" || !resourceInteger(defaults.cpus) || !resourceInteger(defaults.memoryMb)
    || !resourceInteger(defaults.storageGb) || !steps.includes(defaults.storageGb)
    || !combinations.some((entry) => (entry as Record<string, unknown>).cpus === defaults.cpus
      && (entry as Record<string, unknown>).memoryMb === defaults.memoryMb)) fail("catalog_unavailable");
  return value as unknown as ResourceCatalog;
}

export function quoteResources(catalog: ResourceCatalog, specs: ResourceSpecs, current: ResourceSpecs | null): ResourcePrice {
  validateCatalog(catalog);
  if (!record(specs) || specs.cpuKind !== "performance" || !resourceInteger(specs.cpus)
    || !resourceInteger(specs.memoryMb) || !resourceInteger(specs.storageGb)
    || !catalog.combinations.some((entry) => entry.cpus === specs.cpus && entry.memoryMb === specs.memoryMb)) fail("invalid_resources");
  if (!catalog.storageStepsGb.includes(specs.storageGb) && specs.storageGb !== current?.storageGb) fail("invalid_resources");
  return priceSpecs(specs, catalog.formulaVersion);
}

export function validateAutoTopup(settings: { enabled: boolean; thresholdCents: number; amountCents: number }, catalog: ResourceCatalog): void {
  validateCatalog(catalog);
  if (typeof settings.enabled !== "boolean" || !positiveInteger(settings.thresholdCents)
    || !positiveInteger(settings.amountCents) || settings.thresholdCents < catalog.minTopupCents
    || settings.amountCents < catalog.minTopupCents || settings.thresholdCents > catalog.maxTopupCents
    || settings.amountCents > catalog.maxTopupCents || settings.amountCents < settings.thresholdCents) fail("invalid_resources");
}

/** An hourly amount at three decimals; quotes and metering retain integer micro-USD. */
export function formatHourly(microUsd: string): string {
  if (!money(microUsd)) fail("unrepresentable_rate");
  const mills = (BigInt(microUsd) + 500n) / 1000n;
  return `$${mills / 1000n}.${String(mills % 1000n).padStart(3, "0")}`;
}
export function formatHourlyRate(microUsd: string): string {
  return `${formatHourly(microUsd)}/hour`;
}

/** How a running month's price splits between CPU, RAM and SSD, as fractions summing to 1.
 * Null when the price's formula is unknown to this build. */
export function costShares(price: ResourcePrice, specs: { cpus: number; memoryMb: number }): { cpu: number; ram: number; ssd: number } | null {
  const f = formulaFor(price.formulaVersion);
  if (!f || !money(price.computeHourly) || !money(price.storageMonthly)) return null;
  const cpu = Number(BigInt(specs.cpus) * f.cpuHourly), ram = Number(BigInt(specs.memoryMb / 1024) * f.ramGbHourly);
  const compute = Number(price.computeHourly) * Number(f.hoursPerMonth), ssd = Number(price.storageMonthly);
  const total = compute + ssd;
  if (total === 0 || cpu + ram === 0) return null;
  const cpuMonthly = compute * cpu / (cpu + ram);
  return { cpu: cpuMonthly / total, ram: (compute - cpuMonthly) / total, ssd: ssd / total };
}

/** Start needs $1 so tiny top-ups cannot each buy a free minute; the server enforces the same floor. */
export const START_MINIMUM_MICROUSD = 1_000_000n;

export interface RateTriplet { hour: bigint; day: bigint; month: bigint }

/** The all-in charge per hour, day and month: compute plus storage while running,
 * storage alone when paused. Each period derives from the exact monthly figure,
 * so the month shown never drifts from the quoted storage price. */
export function allInRates(price: ResourcePrice, running: boolean): RateTriplet {
  if (!money(price.computeHourly) || !money(price.storageMonthly)) fail("unrepresentable_rate");
  const hours = BigInt(formulaFor(price.formulaVersion)?.hoursPerMonth ?? 730n);
  const month = (running ? BigInt(price.computeHourly) * hours : 0n) + BigInt(price.storageMonthly);
  return { hour: month / hours, day: month * 24n / hours, month };
}

/** One rate three ways, so nobody has to multiply. */
export function formatRateTriplet(rates: RateTriplet): string {
  const each = (v: bigint) => formatMicrousd(String(v));
  return `${each(rates.hour)}/hour · ${each(rates.day)}/day · ${each(rates.month)}/month`;
}

/** Seconds of running time the balance buys: compute plus storage's hourly share. */
export function remainingSeconds(balance: string, price: ResourcePrice): number {
  if (!money(balance) || !money(price.computeHourly) || !money(price.storageMonthly)) fail("unrepresentable_rate");
  const hours = BigInt(formulaFor(price.formulaVersion)?.hoursPerMonth ?? 730n);
  // Per-hour cost scaled by `hours` to stay integer: compute*hours + storageMonthly.
  const scaled = BigInt(price.computeHourly) * hours + BigInt(price.storageMonthly);
  if (scaled === 0n) fail("unrepresentable_rate");
  const seconds = BigInt(balance) * 3600n * hours / scaled;
  return Number(seconds > MAX_MONEY ? MAX_MONEY : seconds);
}
export function formatMonthly(microUsd: string): string {
  return `${formatMicrousd(microUsd)}/month`;
}

/** Parse dollars exactly; never multiply a floating-point currency input. */
export function dollarsToMicrousd(value:string):string|null {
 const match=/^(0|[1-9][0-9]{0,9})(?:\.([0-9]{1,2}))?$/.exec(value.trim());
 return match ? (BigInt(match[1]!)*1000000n+BigInt((match[2]??'').padEnd(2,'0'))*10000n).toString() : null;
}
/** Two decimals, half-up on the magnitude. A negative value keeps a leading minus (U+2212) unless it rounds to nothing. */
export function formatMicrousd(value:string):string {
 const amount=BigInt(value),cents=((amount<0n?-amount:amount)+5000n)/10000n;
 return `${amount<0n&&cents>0n?'−':''}$${cents/100n}.${String(cents%100n).padStart(2,'0')}`;
}
/** A statement amount: credits carry a plus, debits a minus, a rounded-to-zero amount neither. */
export function formatSignedMicrousd(value:string):string {
 const formatted=formatMicrousd(value);
 return formatted.startsWith('−')||formatted==='$0.00'?formatted:`+${formatted}`;
}

export const PRICING_FORMULA_VERSION = "2026-10-03";
export interface PricingFormula {
  version: string; cpuHourly: bigint; ramGbHourly: bigint; ssdGbMonthly: bigint;
  hoursPerMonth: bigint; subsidyStartBp: bigint; subsidyCapMonthly: bigint;
  /** From 2026-10-03: the running and paused monthly prices round to the nearest `small` step below
   * `threshold` and the nearest `large` step from it up (ties round up). Absent in earlier versions. */
  rounding?: { threshold: bigint; small: bigint; large: bigint };
}
/** Every formula a quote may have been accepted under. Add, never edit: the SQL
 * `pricing_formulas` table must carry an identical row for each version. */
export const PRICING_FORMULAS: Readonly<Record<string, PricingFormula>> = Object.freeze({
  "2026-09-26": {
    version: "2026-09-26", cpuHourly: 29_200n, ramGbHourly: 6_950n, ssdGbMonthly: 150_000n,
    hoursPerMonth: 730n, subsidyStartBp: 8_000n, subsidyCapMonthly: 500_000_000n,
  },
  "2026-09-27": {
    version: "2026-09-27", cpuHourly: 29_200n, ramGbHourly: 6_950n, ssdGbMonthly: 150_000n,
    hoursPerMonth: 730n, subsidyStartBp: 8_000n, subsidyCapMonthly: 1_000_000_000n,
  },
  "2026-10-03": {
    version: "2026-10-03", cpuHourly: 29_200n, ramGbHourly: 6_950n, ssdGbMonthly: 150_000n,
    hoursPerMonth: 730n, subsidyStartBp: 8_000n, subsidyCapMonthly: 1_000_000_000n,
    rounding: { threshold: 10_000_000n, small: 100_000n, large: 500_000n },
  },
});
function formulaFor(version: string): PricingFormula | undefined {
  return Object.hasOwn(PRICING_FORMULAS, version) ? PRICING_FORMULAS[version] : undefined;
}
/** Fly cost less a subsidy falling linearly from `subsidyStartBp` at $0 to 0 at
 * `subsidyCapMonthly` of 24/7 monthly cost. Integer micro-USD; rounds down once, then
 * to the formula's `rounding` steps when it has them. */
export function priceSpecs(
  specs: { cpus: number; memoryMb: number; storageGb: number },
  version: string = PRICING_FORMULA_VERSION,
): FormulaPrice {
  const f = formulaFor(version) ?? fail("catalog_unavailable");
  if (!resourceInteger(specs.cpus) || !resourceInteger(specs.memoryMb) || !resourceInteger(specs.storageGb)
    || specs.memoryMb % 1024 !== 0) fail("invalid_resources");
  const computeCost = BigInt(specs.cpus) * f.cpuHourly + BigInt(specs.memoryMb / 1024) * f.ramGbHourly;
  const costMonthly = computeCost * f.hoursPerMonth + BigInt(specs.storageGb) * f.ssdGbMonthly;
  const subsidyBp = costMonthly >= f.subsidyCapMonthly ? 0n
    : f.subsidyStartBp * (f.subsidyCapMonthly - costMonthly) / f.subsidyCapMonthly;
  const factorBp = 10_000n - subsidyBp;
  let computeHourly = computeCost * factorBp / 10_000n;
  let storageMonthly = BigInt(specs.storageGb) * f.ssdGbMonthly * factorBp / 10_000n;
  if (f.rounding) {
    // Round what a customer reads, the paused and running months; the hourly rate is what remains of the
    // running month, floored, so a month of it falls short of the rounded figure by under $0.001.
    const r = f.rounding;
    const round = (v: bigint) => { const step = v < r.threshold ? r.small : r.large; return (v + step / 2n) / step * step; };
    const running = round(computeHourly * f.hoursPerMonth + storageMonthly);
    storageMonthly = round(storageMonthly);
    computeHourly = (running - storageMonthly) / f.hoursPerMonth;
  }
  return {
    computeHourly: String(computeHourly),
    storageMonthly: String(storageMonthly),
    costMonthly: String(costMonthly),
    subsidyBasisPoints: Number(subsidyBp),
    formulaVersion: f.version,
  };
}
