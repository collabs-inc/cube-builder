export const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".bmp", ".tiff", ".tif", ".avif", ".heic", ".heif",
]);

export function isImageFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}
