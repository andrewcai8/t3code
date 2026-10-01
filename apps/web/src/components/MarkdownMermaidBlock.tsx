import { type ReactNode, useEffect, useRef, useState } from "react";

import {
  type MermaidImage,
  type MermaidTheme,
  readCachedMermaidImage,
  renderMermaidImage,
} from "../lib/mermaidRendering";
import { codeFenceFor } from "../markdown-clipboard";

export function MarkdownMermaidBlock({
  code,
  theme,
  source,
}: {
  code: string;
  theme: MermaidTheme;
  source: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [rendered, setRendered] = useState<{
    code: string;
    theme: MermaidTheme;
    image: MermaidImage;
  } | null>(null);
  const exact =
    readCachedMermaidImage(code, theme) ??
    (rendered?.code === code && rendered.theme === theme ? rendered.image : null);
  const settled = exact !== null;
  // Keep the other theme's diagram on screen while this theme renders, so the list does not jump.
  const image = exact ?? readCachedMermaidImage(code, theme === "dark" ? "light" : "dark");

  useEffect(() => {
    const container = containerRef.current;
    if (visible || settled || !container) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [settled, visible]);

  useEffect(() => {
    if (!visible || settled) return;
    let cancelled = false;
    void renderMermaidImage(code, theme).then((next) => {
      if (!cancelled) setRendered({ code, theme, image: next });
    });
    return () => {
      cancelled = true;
    };
  }, [code, settled, theme, visible]);

  if (image?.ok) {
    const fence = codeFenceFor(code);
    return (
      <div ref={containerRef} className="flex justify-center overflow-x-auto px-3 pt-2 pb-3">
        <img
          src={image.src}
          alt="Mermaid diagram"
          className="h-auto max-w-full"
          draggable={false}
          data-markdown-copy={`${fence}mermaid\n${code.replace(/\n$/, "")}\n${fence}\n\n`}
        />
      </div>
    );
  }
  return (
    <div ref={containerRef}>
      {image ? (
        <p className="px-3 pt-1 text-xs text-muted-foreground select-none" role="status">
          This diagram could not be rendered. Showing its source.
        </p>
      ) : null}
      {source}
    </div>
  );
}
