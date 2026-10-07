// Adapted from src/windows/app/src/desktop/apps/cube-icons.tsx at 600e05f2294df5c71026b723915306a74c8cfd3a.
import type { SVGProps } from "react";

/**
 * Cube's app icons: a Lucide-compatible family drawn in the Cube mark's
 * language.
 *
 * Every icon follows Lucide's rules — a 24 × 24 canvas, 1px safe zone, 2px
 * centred strokes, round caps and joins, at least 2px between elements — so
 * it sits beside Lucide or Phosphor line icons. What makes them Cube's comes
 * from the prism mark (sidebar/prism-mark.tsx):
 *
 * - Soft corners: containers take a 3px radius, a little rounder than
 *   Lucide's 2px, like the mark's eased vertices.
 * - The floating face: an inner element held apart from its container, the
 *   way the mark's lower face floats inside the prism.
 * - The mark's own shapes where they mean something — its rhombus face on the
 *   Finder folder (Cube's files), its hexagon as the Settings nut — never as a
 *   frame forced around every icon.
 */
const HEXAGON = "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z";
/** The mark's lower face, centred on (12, cy): a rhombus at the prism's 30° slope. */
const face = (cy: number, w = 4) => `M12 ${cy - w * .577}l${w} ${w * .577}-${w} ${w * .577}-${w}-${w * .577}Z`;

export const CUBE_GLYPHS = {
  /** A prism glyph in the outline family; brand fallbacks use PrismMark's official SVG. */
  cube: [HEXAGON, face(14.4, 4.4)],
  /** Studio: a window holding a prompt — where work happens. */
  studio: ["M4 8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Z", "m8 10 2.5 2-2.5 2", "M12.5 14.5h3"],
  /** Finder: a folder carrying the Cube face. */
  finder: ["M3 8a3 3 0 0 1 3-3h2.8a2 2 0 0 1 1.6.8l.8 1.1a2 2 0 0 0 1.6.8H18a3 3 0 0 1 3 3V16a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Z", face(13.6, 3.8)],
  /** Agents: a spark and its smaller echo. */
  agents: ["M11 4c.6 3.4 1.8 4.6 5.2 5.2-3.4.6-4.6 1.8-5.2 5.2-.6-3.4-1.8-4.6-5.2-5.2 3.4-.6 4.6-1.8 5.2-5.2Z", "M17.5 15v5", "M15 17.5h5"],
  /** Store: a bag — where agents and tools are found and installed. */
  store: ["M5.5 8.5h13l-.9 9.6a3 3 0 0 1-3 2.4H9.4a3 3 0 0 1-3-2.4Z", "M9 8.5V7a3 3 0 0 1 6 0v1.5"],
  /** Market: a storefront for apps. */
  market: ["M4 10v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8", "M3 9l2-5h14l2 5a3 3 0 0 1-4.5 2.6 3 3 0 0 1-4.5 0 3 3 0 0 1-4.5 0A3 3 0 0 1 3 9Z", "M9 20v-5h6v5"],
  /** Tools: a plug — what an agent can be connected to. */
  tools: ["M9.5 4v3.5", "M14.5 4v3.5", "M6 7.5h12v3a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5Z", "M12 15.5V20"],
  /** Machine: a screen on a floating base, its pulse inside. */
  machine: ["M3 7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Z", "M9 20h6", "M7 10h2l1.5-2 3 4 1.5-2h2"],
  /** Settings: the prism's hexagon as a nut around its bolt. */
  settings: [HEXAGON, "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"],
  /** Automations: a loop that runs by itself. */
  automations: ["M19 11a7 7 0 0 0-12.8-3.9L5 8.5", "M5 4.5v4h4", "M5 13a7 7 0 0 0 12.8 3.9L19 15.5", "M19 19.5v-4h-4"],
  /** Add: a plus. */
  add: ["M12 6v12", "M6 12h12"],
} as const;

export type CubeIconName = keyof typeof CUBE_GLYPHS;

export interface CubeIconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: CubeIconName;
  size?: number | string;
  strokeWidth?: number;
  /** Lucide's option: keep the stroke this many CSS pixels wide at any size. */
  absoluteStrokeWidth?: boolean;
}

export function CubeIcon({ name, size = 24, strokeWidth = 1.5, absoluteStrokeWidth, className, ...rest }: CubeIconProps) {
  const width = absoluteStrokeWidth ? (strokeWidth * 24) / Number(size) : strokeWidth;
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" className={["cube-icon", `cube-icon-${name}`, className].filter(Boolean).join(" ")}
    aria-hidden="true" {...rest}>
    {CUBE_GLYPHS[name].map(d => <path key={d} d={d} />)}
  </svg>;
}
