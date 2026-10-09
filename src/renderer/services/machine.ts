import { LOCAL_MACHINE_ID } from '@port/shared/types';

/** A catalog owner tag, not remote routing or an account entitlement. */
export function isInstallationMachine(machineId: string | null): boolean {
  return machineId === LOCAL_MACHINE_ID;
}
