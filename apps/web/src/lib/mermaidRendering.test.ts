// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from "vite-plus/test";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn<(id: string, code: string, container: Element) => Promise<{ svg: string }>>(),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

let rendering: typeof import("./mermaidRendering");

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 360 120"><text>A → B</text></svg>';

function decodeSvg(src: string): Element {
  return new DOMParser().parseFromString(
    decodeURIComponent(src.slice(src.indexOf(",") + 1)),
    "image/svg+xml",
  ).documentElement;
}

beforeEach(async () => {
  vi.resetModules();
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
  rendering = await import("./mermaidRendering");
});

it("renders a strict-mode SVG data URL sized from its viewBox and removes its scratch DOM", async () => {
  mermaid.render.mockImplementation(async (_id, _code, container) => {
    expect(container.isConnected).toBe(true);
    return { svg: SVG };
  });

  const image = await rendering.renderMermaidImage("flowchart TD\n  A --> B\n", "dark");

  if (!image.ok) throw new Error("expected a rendered diagram");
  expect(image.src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  const svg = decodeSvg(image.src);
  expect([svg.getAttribute("width"), svg.getAttribute("height"), svg.textContent]).toEqual([
    "360",
    "120",
    "A → B",
  ]);
  expect(mermaid.initialize).toHaveBeenCalledWith(
    expect.objectContaining({ securityLevel: "strict", theme: "dark", startOnLoad: false }),
  );
  expect(document.body.childElementCount).toBe(0);
});

it("renders one diagram at a time and reuses a render for duplicate and later requests", async () => {
  let finishFirst!: (value: { svg: string }) => void;
  const firstStarted = new Promise<void>((started) => {
    mermaid.render.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        finishFirst = resolve;
      });
    });
  });
  mermaid.render.mockResolvedValueOnce({ svg: SVG.replace("A → B", "light") });

  const dark = rendering.renderMermaidImage("graph TD; A-->B", "dark");
  const duplicate = rendering.renderMermaidImage("graph TD; A-->B", "dark");
  const light = rendering.renderMermaidImage("graph TD; A-->B", "light");
  await firstStarted;
  expect(mermaid.render).toHaveBeenCalledTimes(1);

  finishFirst({ svg: SVG });
  const [darkImage, duplicateImage, lightImage] = await Promise.all([dark, duplicate, light]);

  expect(duplicateImage).toBe(darkImage);
  expect(lightImage.ok && decodeSvg(lightImage.src).textContent).toBe("light");
  expect(rendering.readCachedMermaidImage("graph TD; A-->B", "dark")).toBe(darkImage);
  expect(rendering.readCachedMermaidImage("graph TD; A-->C", "dark")).toBeNull();
  await rendering.renderMermaidImage("graph TD; A-->B", "dark");
  expect(mermaid.render).toHaveBeenCalledTimes(2);
});

it("caches a malformed diagram as failed and keeps rendering the next one", async () => {
  mermaid.render.mockRejectedValueOnce(new Error("Parse error"));
  mermaid.render.mockResolvedValueOnce({ svg: SVG });

  expect(await rendering.renderMermaidImage("flowchart TD\n  A -->", "light")).toEqual({
    ok: false,
  });
  expect(await rendering.renderMermaidImage("flowchart TD\n  A -->", "light")).toEqual({
    ok: false,
  });
  expect((await rendering.renderMermaidImage("graph TD; A-->B", "light")).ok).toBe(true);
  expect(mermaid.render).toHaveBeenCalledTimes(2);
  expect(document.body.childElementCount).toBe(0);
});

it("fails a diagram whose SVG an <img> cannot decode as XML", async () => {
  mermaid.render.mockResolvedValueOnce({ svg: SVG.replace("A → B", "A&nbsp;B") });

  expect(await rendering.renderMermaidImage("graph TD; A-->B", "dark")).toEqual({ ok: false });
});

it("fails an oversized diagram without loading Mermaid", async () => {
  const oversized = `graph TD\n${"  A-->B\n".repeat(rendering.MERMAID_MAX_SOURCE_LENGTH)}`;

  expect(await rendering.renderMermaidImage(oversized, "dark")).toEqual({ ok: false });
  expect(mermaid.initialize).not.toHaveBeenCalled();
});
