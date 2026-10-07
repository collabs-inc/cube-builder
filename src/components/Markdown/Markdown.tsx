// Adapted from packages/components/src/Markdown/Markdown.tsx at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { Children, isValidElement, useEffect, useRef } from "react";
import ReactMarkdown, { type Options as ReactMarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

interface MarkdownProps {
  content: string;
  className?: string;
  enableKatex?: boolean;
}

const COPY_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke="currentColor" stroke-width="2" /><path d="M5 15H4C2.89543 15 2 14.1046 2 13V4C2 2.89543 2.89543 2 4 2H13C14.1046 2 15 2.89543 15 4V5" stroke="currentColor" stroke-width="2" /></svg>';

const SUCCESS_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 12L11 14L15 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" /></svg>';

export function Markdown({
  content,
  className,
  enableKatex = false,
}: MarkdownProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const katexDisplays = enableKatex
      ? Array.from(
          container.querySelectorAll<HTMLElement>(".katex-display"),
        )
      : [];

    const codeBlocks = Array.from(
      container.querySelectorAll<HTMLElement>("pre"),
    );

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const targetEl = e.currentTarget as HTMLElement;
      if (e.deltaX) {
        targetEl.scrollLeft += e.deltaX;
      }
      if (e.deltaY) {
        window.scrollBy({ top: e.deltaY });
      }
    };

    const cleanupHandlers: Array<() => void> = [];

    codeBlocks.forEach((preEl) => {
      preEl.style.position = preEl.style.position || "relative";
      if (preEl.querySelector(".code-copy-btn")) return;

      const btn = document.createElement("button");
      btn.className = "copy-button code-copy-btn";
      btn.type = "button";
      btn.title = "Copy code";
      btn.innerHTML = COPY_ICON;

      const clickHandler = async (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const codeEl = preEl.querySelector("code");
        const text = codeEl
          ? (codeEl.textContent ?? "")
          : (preEl.textContent ?? "");
        try {
          await navigator.clipboard.writeText(text);
          btn.classList.add("copy-success");
          btn.title = "Copied!";
          btn.innerHTML = SUCCESS_ICON;
          setTimeout(() => {
            btn.classList.remove("copy-success");
            btn.title = "Copy code";
            btn.innerHTML = COPY_ICON;
          }, 2000);
        } catch (err) {
          console.error("Failed to copy:", err);
        }
      };

      btn.addEventListener("click", clickHandler);
      preEl.insertBefore(btn, preEl.firstChild);
      cleanupHandlers.push(() => {
        btn.removeEventListener("click", clickHandler);
        if (btn.parentElement === preEl) {
          preEl.removeChild(btn);
        }
      });
    });

    const scrollableElements = [...katexDisplays, ...codeBlocks];
    scrollableElements.forEach((el) =>
      el.addEventListener("wheel", onWheel, { passive: false }),
    );

    return () => {
      scrollableElements.forEach((el) =>
        el.removeEventListener("wheel", onWheel as EventListener),
      );
      cleanupHandlers.forEach((fn) => fn());
    };
  }, [content, enableKatex]);

  const remarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [
    remarkGfm,
    remarkBreaks,
  ];
  if (enableKatex) {
    remarkPlugins.push(remarkMath);
  }

  const rehypePlugins: NonNullable<ReactMarkdownOptions["rehypePlugins"]> =
    enableKatex ? [rehypeKatex] : [];

  return (
    <div
      ref={containerRef}
      className={className ? `${className} markdown-content` : "markdown-content"}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={(url) => url}
        components={{
          p: ({ children, ...paragraphProps }) => {
            const hasBlock = Children.toArray(children).some((child) => {
              if (!isValidElement(child)) return false;
              const t = child.type;
              return (
                typeof t === "string" &&
                (t === "pre" ||
                  t === "div" ||
                  t === "table" ||
                  t === "ul" ||
                  t === "ol")
              );
            });
            if (hasBlock) return <>{children}</>;
            return <p {...paragraphProps}>{children}</p>;
          },
          img: ({ src, alt, ...props }) => {
            if (!src) return null;
            return (
              <img
                {...props}
                src={src}
                alt={alt || "Image"}
                loading="lazy"
                style={{ maxWidth: "100%", height: "auto" }}
              />
            );
          },
          code: ({ className: codeClassName, children, ...rest }) => {
            return (
              <code className={codeClassName} {...rest}>
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
