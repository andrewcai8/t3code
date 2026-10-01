import type { Mermaid } from "mermaid";

import { fnv1a32 } from "./diffRendering";
import { LRUCache } from "./lruCache";

export type MermaidTheme = "light" | "dark";

export type MermaidImage = { readonly ok: true; readonly src: string } | { readonly ok: false };

export const MERMAID_MAX_SOURCE_LENGTH = 20_000;

const FAILED: MermaidImage = { ok: false };
const images = new LRUCache<MermaidImage>(64, 8 * 1024 * 1024);
const inFlight = new Map<string, Promise<MermaidImage>>();
let queue: Promise<unknown> = Promise.resolve();
let nextDiagramId = 0;

export function isMermaidLanguage(language: string): boolean {
  return language.toLowerCase() === "mermaid";
}

function imageKey(code: string, theme: MermaidTheme): string {
  return `${theme}:${fnv1a32(code).toString(36)}:${code.length}`;
}

export function readCachedMermaidImage(code: string, theme: MermaidTheme): MermaidImage | null {
  return images.get(imageKey(code, theme));
}

/**
 * Renders one diagram at a time, because Mermaid keeps its theme in global
 * configuration. Never rejects. The result is an SVG data URL meant for an
 * `<img>`, where diagram content cannot run script or touch the page DOM.
 */
export function renderMermaidImage(code: string, theme: MermaidTheme): Promise<MermaidImage> {
  const key = imageKey(code, theme);
  const cached = images.get(key);
  if (cached) return Promise.resolve(cached);
  if (code.length > MERMAID_MAX_SOURCE_LENGTH) return Promise.resolve(FAILED);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const result = queue
    .then(() => import("mermaid"))
    .then(
      async ({ default: mermaid }) => {
        const image = await renderWith(mermaid, code, theme);
        images.set(key, image, (key.length + (image.ok ? image.src.length : 0)) * 2);
        return image;
      },
      () => FAILED,
    )
    .finally(() => inFlight.delete(key));
  inFlight.set(key, result);
  queue = result;
  return result;
}

async function renderWith(
  mermaid: Mermaid,
  code: string,
  theme: MermaidTheme,
): Promise<MermaidImage> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    maxTextSize: MERMAID_MAX_SOURCE_LENGTH,
    htmlLabels: false,
    fontFamily: "Arial, sans-serif",
    flowchart: { wrappingWidth: 320 },
    theme: theme === "dark" ? "dark" : "default",
    // Keys a diagram's own init directive may not override.
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "suppressErrorRendering",
      "maxEdges",
      "htmlLabels",
    ],
  });
  // Mermaid measures label text in a live element before it lays out the graph.
  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.style.cssText = "position:fixed;inset:0;visibility:hidden;pointer-events:none";
  document.body.append(container);
  try {
    const { svg } = await mermaid.render(`t3-mermaid-${++nextDiagramId}`, code, container);
    const src = svgToImageSource(svg);
    return src ? { ok: true, src } : FAILED;
  } catch {
    return FAILED;
  } finally {
    container.remove();
  }
}

function svgToImageSource(svg: string): string | null {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  // Mermaid serializes through innerHTML, so a label can carry an HTML entity such
  // as &nbsp; that an <img> rejects when it decodes the SVG as XML.
  if (parsed.getElementsByTagName("parsererror").length > 0) return null;
  const element = parsed.documentElement;
  const [, , width = 0, height = 0] =
    element
      .getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number) ?? [];
  let source = svg;
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    // Mermaid emits width="100%", which an <img> resolves against a 300x150 default viewport.
    element.setAttribute("width", String(width));
    element.setAttribute("height", String(height));
    source = new XMLSerializer().serializeToString(element);
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}
