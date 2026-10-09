/** A sidebar row that takes part in a sibling set's drag reorder (spec §2.6). */



import { useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";

export interface SortableBind {
  setNodeRef: (node: HTMLElement | null) => void;
  setActivatorNodeRef: (node: HTMLElement | null) => void;
  activatorProps: Record<string, unknown>;
  style: CSSProperties;
  isDragging: boolean;
}

export function SortableRow({ id, scopeId, disabled = false, children }: {
  id: string;
  scopeId: string;
  disabled?: boolean;
  children: (bind: SortableBind) => ReactNode;
}) {
  const nodeRef = useRef<HTMLElement | null>(null);
  const getContainerRect = useCallback(
    () => nodeRef.current?.closest<HTMLElement>("[data-sortable-container]")?.getBoundingClientRect() ?? null,
    [],
  );
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({
    id,
    disabled,
    data: { scopeId, getContainerRect },
  });
  const bindNode = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node;
    setNodeRef(node);
  }, [setNodeRef]);
  // The element keeps its own role and tab order (Global Constraints).
  const { role: _role, tabIndex: _tabIndex, ...sortableAttributes } = attributes;
  const style: CSSProperties = {
    ...(transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : {}),
    ...(transition ? { transition } : {}),
    ...(isDragging ? { opacity: 0.6 } : {}),
  };
  return <>{children({ setNodeRef: bindNode, setActivatorNodeRef, activatorProps: { ...sortableAttributes, ...listeners }, style, isDragging })}</>;
}
