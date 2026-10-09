import type { ReorderScope } from "@port/shared/catalog-order";
import { services } from "../services";
import { previewCatalogOrder } from "../state/catalog";

/** Commit the visual drop before dnd-kit clears its transforms. */
export async function reorderCatalog(machineId: string, scope: ReorderScope, ids: string[]) {
  const rollback = previewCatalogOrder(machineId, scope, ids);
  try {
    const result = await services.catalog.reorder(machineId, scope, ids);
    if (!result.ok) rollback();
    return result;
  } catch (error) {
    rollback();
    throw error;
  }
}
