/**
 * Module-level services singleton. Renderer code imports `services` and
 * calls through it — never `window.api` directly (see electron.ts's
 * comment). Tests swap in the fake with `setServices`.
 */



import type { Services } from "./types";

// The standalone browser adapter is installed before Builder boots.
let current: Services | null = null;

export function setServices(next: Services): void {
  current = next;
}

function resolve(): Services {
  if (current) return current;
  throw new Error(
    "Builder services have not been initialized."
  );
}

// Destructuring a group (`const { pty } = services`) snapshots whatever
// implementation was current at that moment; always call through
// `services.<group>.<method>()` in app code instead, so tests that swap
// implementations via setServices() after module init still take effect.
export const services: Services = new Proxy({} as Services, {
  get(_target, prop: keyof Services) {
    return resolve()[prop];
  },
});
