// packages/shared/src/binary-sample.ts
//
// "Is this file binary?" as a pure decision over bytes someone else read.
// Moved verbatim from src/main/file-filter.ts so the Electron main process and
// cubed reach the same verdict on the same bytes — when the daemon took over
// filtering local listings, a second, cruder heuristic living there meant a
// UTF-16 text file (NUL bytes everywhere) disappeared from the user's tree.
//
// Same split as the ignore patterns next door: the judgement is pure and
// shared, the fs read that feeds it stays with whoever can see the files.

/** How much of a file is enough to judge it. Callers should read this many bytes. */
export const BINARY_SAMPLE_SIZE = 8000;

/**
 * True if the sample opens with a UTF-8 or UTF-16 byte-order mark. A BOM is a
 * promise that the file is text, and UTF-16 text is half NUL bytes — without
 * this check the NUL rule below would condemn every one of them.
 */
export function hasTextBom(sample: Uint8Array): boolean {
  if (sample.length >= 3 &&
    sample[0] === 0xef &&
    sample[1] === 0xbb &&
    sample[2] === 0xbf) {
    return true;
  }

  if (sample.length >= 2) {
    const first = sample[0];
    const second = sample[1];
    if (
      (first === 0xff && second === 0xfe) ||
      (first === 0xfe && second === 0xff)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * A NUL byte means binary outright; short of that, a sample more than a tenth
 * control characters means binary too. An empty sample and a BOM'd one are
 * text by definition.
 */
export function isBinarySample(sample: Uint8Array): boolean {
  if (sample.length === 0 || hasTextBom(sample)) {
    return false;
  }

  let suspiciousBytes = 0;

  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }

    const isControlChar = byte < 7 ||
      (byte > 14 && byte < 32) ||
      byte === 127;
    if (isControlChar) {
      suspiciousBytes++;
    }
  }

  return suspiciousBytes / sample.length > 0.1;
}
