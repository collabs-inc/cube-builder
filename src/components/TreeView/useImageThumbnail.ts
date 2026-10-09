import { services } from "../../renderer/services";
import { useState, useEffect } from "react";
import { isImageFile } from "@port/shared/image";

export function useImageThumbnail(
  filePath: string,
  size: number,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = isImageFile(filePath);

  useEffect(() => {
    if (!isImage) return;
    let cancelled = false;

    services.files.getImageThumbnail(filePath, size)
      .then((result) => {
        if (!cancelled) setUrl(result);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, size, isImage]);

  return isImage ? url : null;
}
