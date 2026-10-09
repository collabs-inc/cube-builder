// Cloud images use scoped HTTP previews. PDFs still use the local-only
// cube-file viewer and keep an explicit placeholder until that is ported.
import { isPdfFile } from "@port/shared/pdf";
import { parseCloudPath } from "@port/shared/path-utils";

export function isCloudPath(path: string): boolean {
  return parseCloudPath(path) !== null;
}

export function needsBinaryTransport(path: string): boolean {
  return isCloudPath(path) && isPdfFile(path);
}
