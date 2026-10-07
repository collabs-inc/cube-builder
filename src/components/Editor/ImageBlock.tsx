// Adapted from packages/components/src/Editor/ImageBlock.tsx at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { createContext, useContext, useEffect, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import {
  createImageBlockConfig,
  imageParse,
  type ImageBlockConfig,
  type ImageOptions,
  type Props,
} from "@blocknote/core";
import { resolveImage } from "../../web/services/assets";

export const ImageResolverContext = createContext<{ notePath: string }>({
  notePath: "",
});

function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isWikiImageUrl(url: string): boolean {
  return url.startsWith("wikiimage:");
}

function extractWikiImageRef(url: string): string {
  const raw = url.slice("wikiimage:".length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

type ResolvedState =
  | { status: "loading" }
  | { status: "resolved"; src: string }
  | { status: "error"; reference: string };

function useResolvedImageUrl(
  url: string,
  notePath: string,
): ResolvedState {
  const [state, setState] = useState<ResolvedState>(() => {
    if (!url) return { status: "error", reference: "" };
    if (isExternalUrl(url)) {
      return { status: "resolved", src: url };
    }
    return { status: "loading" };
  });

  useEffect(() => {
    if (!url) {
      setState({ status: "error", reference: "" });
      return;
    }
    if (isExternalUrl(url)) {
      setState({ status: "resolved", src: url });
      return;
    }

    setState({ status: "loading" });
    let cancelled = false;
    const reference = isWikiImageUrl(url)
      ? extractWikiImageRef(url)
      : url;

    if (!notePath) {
      setState({ status: "error", reference });
      return;
    }

    resolveImage(reference, notePath)
      .then((resolved) => {
        if (cancelled) return;
        if (resolved) {
          setState({ status: "resolved", src: resolved });
        } else {
          setState({ status: "error", reference });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error", reference });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url, notePath]);

  return state;
}

function ImageRenderer(
  props: { block: { props: { url: string; name: string } } },
) {
  const { notePath } = useContext(ImageResolverContext);
  const { url, name } = props.block.props;
  const [loadError, setLoadError] = useState(false);
  const resolved = useResolvedImageUrl(url, notePath);

  useEffect(() => {
    setLoadError(false);
  }, [url, notePath]);

  if (!url) {
    return (
      <div className="image-block-empty">
        <span className="image-block-empty-text">
          No image source
        </span>
      </div>
    );
  }

  if (resolved.status === "loading") {
    return (
      <div className="image-block-loading">
        <span className="image-block-loading-text">
          Loading image...
        </span>
      </div>
    );
  }

  if (resolved.status === "error" || loadError) {
    const displayName =
      (resolved.status === "error" ? resolved.reference : null) ||
      name || url;
    return (
      <div className="image-block-not-found">
        <span className="image-block-not-found-icon">
          &#x1F5BC;
        </span>
        <span className="image-block-not-found-text">
          Image not found: {displayName}
        </span>
      </div>
    );
  }

  return (
    <img
      className="image-block-img"
      src={resolved.src}
      alt={name || ""}
      draggable={false}
      onError={() => setLoadError(true)}
    />
  );
}

// createImageBlockConfig's declared type is a union of a 0-arg and a
// required-1-arg signature, which is uncallable as written — cast to the
// optional-arg shape the runtime actually implements.
const imageConfig = (
  createImageBlockConfig as (options?: ImageOptions) => ImageBlockConfig
)();

// imageParse's parser returns props with explicit `undefined` values, which
// exactOptionalPropertyTypes rejects — strip them before handing to BlockNote.
function parseImageElement(
  element: HTMLElement,
): Partial<Props<ImageBlockConfig["propSchema"]>> | undefined {
  const parsed = imageParse()(element);
  if (!parsed) return undefined;
  const props: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined) props[key] = value;
  }
  return props as Partial<Props<ImageBlockConfig["propSchema"]>>;
}

export const CustomImageBlock = createReactBlockSpec(
  imageConfig,
  {
    meta: {
      fileBlockAccept: ["image/*"],
    },
    render: (props) => (
      <ImageRenderer block={props.block} />
    ),
    parse: parseImageElement,
    toExternalHTML: (props) => {
      const { url, name } = props.block.props;
      if (!url) return <p />;
      return <img src={url} alt={name || ""} />;
    },
    runsBefore: ["file"],
  },
);
