export type PlanId = "aluminum" | "stainless" | "titanium" | "pro_legacy";
export type SalePlanId = Exclude<PlanId, "pro_legacy">;
export type BillingInterval = "month";
export type TaxBehavior = "exclusive" | "inclusive";

export interface PricingPlan {
  readonly id: SalePlanId;
  readonly name: string;
  readonly amountCents: number;
  readonly currency: "usd";
  readonly interval: BillingInterval;
  readonly intervalCount: number;
  readonly trialDays: number;
  readonly cpuKind: "performance";
  readonly cpus: number;
  readonly memoryMb: number;
  readonly storageGb: number;
  readonly available: boolean;
  readonly displayOrder: number;
  readonly features: readonly string[];
  readonly taxBehavior: TaxBehavior;
  readonly taxDisplay: string;
}

export interface PricingCatalog {
  readonly schemaVersion: 1;
  readonly contentRevision: string;
  readonly plans: readonly PricingPlan[];
}

export interface StripePriceBinding {
  readonly planId: PlanId;
  readonly stripeProductId: string;
  readonly stripePriceId: string;
  /** True only for the one current purchase destination for a public plan. */
  readonly forSale: boolean;
}

export interface PricingRelease extends PricingCatalog {
  readonly stripePriceBindings: readonly StripePriceBinding[];
  readonly portalConfigurationId: string;
}

export interface PricingReleaseBindings {
  readonly stripePriceBindings: readonly StripePriceBinding[];
  readonly portalConfigurationId: string;
}

export const SALE_PLAN_IDS = Object.freeze(
  ["aluminum", "stainless", "titanium"] as const satisfies readonly SalePlanId[],
);

const PLAN_IDS = new Set<PlanId>([...SALE_PLAN_IDS, "pro_legacy"]);
const SALE_PLAN_ID_SET = new Set<SalePlanId>(SALE_PLAN_IDS);
const CATALOG_KEYS = ["schemaVersion", "contentRevision", "plans"];
const PLAN_KEYS = [
  "id",
  "name",
  "amountCents",
  "currency",
  "interval",
  "intervalCount",
  "trialDays",
  "cpuKind",
  "cpus",
  "memoryMb",
  "storageGb",
  "available",
  "displayOrder",
  "features",
  "taxBehavior",
  "taxDisplay",
];
const BINDING_KEYS = ["planId", "stripeProductId", "stripePriceId", "forSale"];
const REVISION_PATTERN = /^sha256:[a-f0-9]{64}$/;
const STRIPE_PRODUCT_PATTERN = /^prod_[A-Za-z0-9_]+$/;
const STRIPE_PRICE_PATTERN = /^price_[A-Za-z0-9_]+$/;
const PORTAL_CONFIGURATION_PATTERN = /^bpc_[A-Za-z0-9_]+$/;
const FEATURE_PATTERN = /^[a-z][a-z0-9_]*$/;

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported`);
  }
  for (const key of expected) {
    if (!(key in value)) throw new Error(`${path}.${key} is required`);
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function integer(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${path} must be an integer of at least ${minimum}`);
  }
  return value as number;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function parseSalePlanId(value: unknown, path: string): SalePlanId {
  if (typeof value !== "string" || !SALE_PLAN_ID_SET.has(value as SalePlanId)) {
    throw new Error(`${path} must be aluminum, stainless, or titanium; legacy terms are customer-specific`);
  }
  return value as SalePlanId;
}

function parsePlanId(value: unknown, path: string): PlanId {
  if (typeof value !== "string" || !PLAN_IDS.has(value as PlanId)) {
    throw new Error(`${path} is not a recognized plan id`);
  }
  return value as PlanId;
}

function parsePlan(value: unknown, index: number): PricingPlan {
  const path = `catalog.plans[${index}]`;
  const input = record(value, path);
  exactKeys(input, PLAN_KEYS, path);

  const id = parseSalePlanId(input.id, `${path}.id`);
  const name = string(input.name, `${path}.name`);
  const amountCents = integer(input.amountCents, `${path}.amountCents`, 1);
  if (input.currency !== "usd") throw new Error(`${path}.currency must be usd`);
  if (input.interval !== "month") throw new Error(`${path}.interval must be month`);
  const intervalCount = integer(input.intervalCount, `${path}.intervalCount`, 1);
  const trialDays = integer(input.trialDays, `${path}.trialDays`, 0);
  if (input.cpuKind !== "performance") throw new Error(`${path}.cpuKind must be performance`);
  const cpus = integer(input.cpus, `${path}.cpus`, 1);
  if (cpus > 16) throw new Error(`${path}.cpus must be at most 16`);
  const memoryMb = integer(input.memoryMb, `${path}.memoryMb`, 1024);
  if (memoryMb % 256 !== 0 || memoryMb < cpus * 1024) {
    throw new Error(`${path}.memoryMb must be a 256 MB multiple with at least 1024 MB per CPU`);
  }
  const storageGb = integer(input.storageGb, `${path}.storageGb`, 1);
  const available = boolean(input.available, `${path}.available`);
  const displayOrder = integer(input.displayOrder, `${path}.displayOrder`, 1);
  if (!Array.isArray(input.features) || input.features.length === 0) {
    throw new Error(`${path}.features must be a non-empty array`);
  }
  const features = input.features.map((feature, featureIndex) => {
    const parsed = string(feature, `${path}.features[${featureIndex}]`);
    if (!FEATURE_PATTERN.test(parsed)) throw new Error(`${path}.features[${featureIndex}] is invalid`);
    return parsed;
  });
  if (new Set(features).size !== features.length) throw new Error(`${path}.features contains a duplicate`);
  if (input.taxBehavior !== "exclusive" && input.taxBehavior !== "inclusive") {
    throw new Error(`${path}.taxBehavior must be explicit`);
  }
  const taxDisplay = string(input.taxDisplay, `${path}.taxDisplay`);

  return Object.freeze({
    id,
    name,
    amountCents,
    currency: "usd",
    interval: "month",
    intervalCount,
    trialDays,
    cpuKind: "performance",
    cpus,
    memoryMb,
    storageGb,
    available,
    displayOrder,
    features: Object.freeze(features),
    taxBehavior: input.taxBehavior,
    taxDisplay,
  });
}

/** Parse an untrusted, revisioned public catalog and return a detached value. */
export function parsePricingCatalog(value: unknown): PricingCatalog {
  const input = record(value, "catalog");
  exactKeys(input, CATALOG_KEYS, "catalog");
  if (input.schemaVersion !== 1) throw new Error("catalog.schemaVersion must be 1");
  const contentRevision = string(input.contentRevision, "catalog.contentRevision");
  if (!REVISION_PATTERN.test(contentRevision)) {
    throw new Error("catalog.contentRevision must be a lowercase sha256 revision");
  }
  if (!Array.isArray(input.plans)) throw new Error("catalog.plans must be an array");
  const plans = input.plans.map(parsePlan);
  const ids = new Set<SalePlanId>();
  const orders = new Set<number>();
  for (const plan of plans) {
    if (ids.has(plan.id)) throw new Error(`duplicate plan id: ${plan.id}`);
    if (orders.has(plan.displayOrder)) throw new Error(`duplicate plan displayOrder: ${plan.displayOrder}`);
    ids.add(plan.id);
    orders.add(plan.displayOrder);
  }
  for (const id of SALE_PLAN_IDS) {
    if (!ids.has(id)) throw new Error(`catalog is missing plan id: ${id}`);
  }
  if (plans.length !== SALE_PLAN_IDS.length) throw new Error("catalog contains an unexpected plan");

  return Object.freeze({ schemaVersion: 1, contentRevision, plans: Object.freeze(plans) });
}

function parseBinding(value: unknown, index: number): StripePriceBinding {
  const path = `stripePriceBindings[${index}]`;
  const input = record(value, path);
  exactKeys(input, BINDING_KEYS, path);
  const planId = parsePlanId(input.planId, `${path}.planId`);
  const stripeProductId = string(input.stripeProductId, `${path}.stripeProductId`);
  const stripePriceId = string(input.stripePriceId, `${path}.stripePriceId`);
  const forSale = boolean(input.forSale, `${path}.forSale`);
  if (!STRIPE_PRODUCT_PATTERN.test(stripeProductId)) throw new Error(`${path}.stripeProductId is invalid`);
  if (!STRIPE_PRICE_PATTERN.test(stripePriceId)) throw new Error(`${path}.stripePriceId is invalid`);
  if (planId === "pro_legacy" && forSale) throw new Error("legacy bindings cannot be sale destinations");
  return Object.freeze({ planId, stripeProductId, stripePriceId, forSale });
}

/**
 * Validate identifiers in a provider-verified release. This does not call
 * Stripe or enable automatic tax; publication is responsible for comparing
 * provider terms before persisting these bindings.
 */
export function createPricingRelease(
  catalogValue: unknown,
  releaseBindings: PricingReleaseBindings,
): PricingRelease {
  const catalog = parsePricingCatalog(catalogValue);
  const input = record(releaseBindings, "releaseBindings");
  exactKeys(input, ["stripePriceBindings", "portalConfigurationId"], "releaseBindings");
  if (!Array.isArray(input.stripePriceBindings)) {
    throw new Error("releaseBindings.stripePriceBindings must be an array");
  }
  const stripePriceBindings = input.stripePriceBindings.map(parseBinding);
  const seenPriceIds = new Set<string>();
  for (const binding of stripePriceBindings) {
    if (seenPriceIds.has(binding.stripePriceId)) {
      throw new Error(`duplicate Stripe price id: ${binding.stripePriceId}`);
    }
    seenPriceIds.add(binding.stripePriceId);
  }
  for (const plan of catalog.plans) {
    const saleBindings = stripePriceBindings.filter((binding) => binding.planId === plan.id && binding.forSale);
    const expected = plan.available ? 1 : 0;
    if (saleBindings.length !== expected) {
      throw new Error(`plan ${plan.id} requires exactly ${expected} sale binding(s)`);
    }
  }
  const portalConfigurationId = string(input.portalConfigurationId, "releaseBindings.portalConfigurationId");
  if (!PORTAL_CONFIGURATION_PATTERN.test(portalConfigurationId)) {
    throw new Error("releaseBindings.portalConfigurationId is invalid");
  }

  return Object.freeze({
    ...catalog,
    stripePriceBindings: Object.freeze(stripePriceBindings),
    portalConfigurationId,
  });
}

/** Return the provider-free shape safe for public endpoints and UI snapshots. */
export function publicCatalog(release: PricingRelease): PricingCatalog {
  return parsePricingCatalog({
    schemaVersion: release.schemaVersion,
    contentRevision: release.contentRevision,
    plans: release.plans,
  });
}

/** Resolve only a currently offered plan at the exact revision the buyer saw. */
export function resolveSalePlan(
  catalog: PricingCatalog,
  planId: unknown,
  contentRevision: string,
): PricingPlan {
  if (contentRevision !== catalog.contentRevision) {
    throw new Error(`catalog revision ${contentRevision} is stale; expected ${catalog.contentRevision}`);
  }
  if (typeof planId !== "string" || !SALE_PLAN_ID_SET.has(planId as SalePlanId)) {
    throw new Error(`plan ${String(planId)} is not available for sale`);
  }
  const plan = catalog.plans.find((candidate) => candidate.id === planId);
  if (!plan?.available) throw new Error(`plan ${planId} is not available for sale`);
  return plan;
}

/** Find a recognized current or historical plan by an exact provider price ID. */
export function resolveStripePrice(release: PricingRelease, stripePriceId: string): StripePriceBinding | null {
  return release.stripePriceBindings.find((binding) => binding.stripePriceId === stripePriceId) ?? null;
}

/** Return the one current sale binding established by release validation. */
export function resolveSaleBinding(release: PricingRelease, planId: SalePlanId): StripePriceBinding {
  const binding = release.stripePriceBindings.find((candidate) => candidate.planId === planId && candidate.forSale);
  if (!binding) throw new Error(`plan ${planId} has no verified sale binding`);
  return binding;
}
