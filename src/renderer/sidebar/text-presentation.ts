/**
 * Pins emoji-capable glyphs to their TEXT presentation.
 *
 * Agent session titles carry characters like U+2733 ✳ that Unicode lists
 * as emoji-capable but text-by-default. macOS honours the default and
 * draws a monochrome glyph; iOS does not, and paints a colour emoji in
 * its place. `font-variant-emoji: text` would settle it in CSS, but
 * Safari does not implement that property (2026-09-02), so the
 * presentation is fixed in the string instead: VARIATION SELECTOR-15
 * (U+FE0E) after each such character, which every renderer honours.
 *
 * Only text-by-default characters are touched. A real emoji (one with
 * the Emoji_Presentation property, 😀) keeps its colour form, an explicit
 * selector already present (FE0E or FE0F) is respected, and ASCII — which
 * Unicode also lists as emoji-capable for digits, `#` and `*` — is left
 * alone. Idempotent.
 */
const EMOJI_CAPABLE = /\p{Emoji}(?![︎️])/gu;
const KEEPS_ITS_FORM = /[\p{ASCII}\p{Emoji_Presentation}]/u;

export function textPresentation(text: string): string {
  return text.replace(EMOJI_CAPABLE, (ch) => (KEEPS_ITS_FORM.test(ch) ? ch : `${ch}︎`));
}
