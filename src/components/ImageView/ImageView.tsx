// Adapted from packages/components/src/ImageView/ImageView.tsx at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { useEffect, useState } from "react";
import { FileImage } from "@phosphor-icons/react/dist/csr/FileImage";
const displayBasename = (path: string) => path.split("/").at(-1);
import { LoadingPulse } from "../LoadingPulse";

interface ImageData { url: string; width: number; height: number }
interface ImageViewProps {
  filePath: string;
  fileStats: { ctime: string; mtime: string } | null;
  theme: "light" | "dark";
  className?: string;
  loadImage: (path: string) => Promise<ImageData>;
}


/** CSS fits the complete image inside the padded viewport, preserving aspect ratio. */
export function ImageView({ filePath, fileStats, className, loadImage }: ImageViewProps) {
  const [image, setImage] = useState<ImageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const filename = displayBasename(filePath) || filePath;

  useEffect(() => {
    let cancelled = false;
    setImage(null);
    setLoaded(false);
    setError(null);
    void loadImage(filePath).then(data => {
      if (!cancelled) setImage(data);
    }, error => {
      if (!cancelled) setError(error instanceof Error ? error.message : "Preview unavailable");
    });
    return () => { cancelled = true; };
  }, [filePath, fileStats?.mtime, loadImage, retry]);

  return (
    <div className={`image-view${className ? ` ${className}` : ""}`}>
      {error ? <div className="image-view-error" role="alert">
        <FileImage size={32} weight="thin" />
        <span>{error}</span>
        <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button>
      </div> : <>
        {!loaded && <LoadingPulse className="image-view-loading" label="Loading image" />}
        {image && <img className="image-view-image"
          src={image.url} alt={filename} draggable={false}
          style={{ visibility: loaded ? "visible" : "hidden" }}
          onLoad={event => {
            const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
            setImage(current => current ? { ...current, width, height } : current);
            setLoaded(true);
          }}
          onError={() => setError("Could not load this image. Retry to reload the file.")}
        />}
      </>}
    </div>
  );
}
