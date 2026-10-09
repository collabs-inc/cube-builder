import { ATTENTION_LABELS, type Attention } from "./attention";
import "./attention.css";

/**
 * The one agent-attention dot every surface renders. Colour and fill carry
 * the state, never font weight; idle renders nothing at all.
 */
export function AttentionDot({ state, className }: { state: Attention; className?: string }) {
  if (state === "idle") return null;
  const label = ATTENTION_LABELS[state];
  return (
    <span
      className={`attention-dot${className ? ` ${className}` : ""}`}
      data-state={state}
      role="img"
      title={label}
      aria-label={label}
    />
  );
}
