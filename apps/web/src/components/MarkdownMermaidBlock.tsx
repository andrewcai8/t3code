import { ChartNetworkIcon, CodeXmlIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import {
  isMermaidLanguage,
  type MermaidImage,
  type MermaidTheme,
  readCachedMermaidImage,
  renderMermaidImage,
} from "../lib/mermaidRendering";
import { Button } from "./ui/button";

function codeFenceFor(code: string): string {
  const longestRun = [...(code.match(/`{3,}/g) ?? [])].reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

/**
 * How a chat code block shows a closed `mermaid` fence: as its diagram, with a toggle back to the
 * source. Undefined for any other block, and for a fence still streaming.
 */
export function mermaidPreview(
  language: string,
  code: string,
  theme: MermaidTheme,
  closed: boolean,
): ((source: ReactNode) => ReactNode) | undefined {
  return isMermaidLanguage(language) && closed
    ? (source) => <MarkdownMermaidBlock code={code} theme={theme} source={source} />
    : undefined;
}

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
  const [showSource, setShowSource] = useState(false);
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

  const toggleLabel = showSource ? "Show diagram" : "Show source";
  const toggle = (
    <Button
      type="button"
      variant="ghost-muted"
      size="icon-xs"
      className="absolute top-1 right-1 z-1"
      onClick={() => setShowSource((value) => !value)}
      aria-label={toggleLabel}
      title={toggleLabel}
    >
      {showSource ? <ChartNetworkIcon className="size-3" /> : <CodeXmlIcon className="size-3" />}
    </Button>
  );
  if (image?.ok && showSource) {
    return (
      <div ref={containerRef} className="relative">
        {toggle}
        {source}
      </div>
    );
  }
  if (image?.ok) {
    const fence = codeFenceFor(code);
    return (
      <div
        ref={containerRef}
        className="relative flex justify-center overflow-x-auto px-3 pt-2 pb-3"
      >
        {toggle}
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
