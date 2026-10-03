import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderMermaidImage } from "../lib/mermaidRendering";
import { Button } from "./ui/button";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("../lib/mermaidRendering", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/mermaidRendering")>()),
  readCachedMermaidImage: () => null,
  renderMermaidImage: vi.fn(),
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";

function codeButton(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType(Button)
    .find((instance) => instance.props["aria-label"] === label);
  if (!button) throw new Error(`Missing code button: ${label}`);
  return button.props as ComponentProps<typeof Button>;
}

describe("ChatMarkdown Mermaid diagrams", () => {
  const diagram = "```mermaid\nflowchart TD\n  A --> B\n```";
  const src = "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E";
  const imageSources = (renderer: ReactTestRenderer) =>
    renderer.root.findAllByType("img").map((image) => image.props.src as string);
  const showsSource = (renderer: ReactTestRenderer) =>
    renderer.root.findAll(
      (node) => node.type === "pre" || node.props.className === "chat-markdown-shiki",
    ).length === 1;

  it("keeps a streaming fence as code and renders it once, after the message completes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(renderMermaidImage).mockReset().mockResolvedValue({ ok: true, src });
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd={undefined} text={diagram} isStreaming />);
      });
      expect(imageSources(renderer!)).toEqual([]);

      await act(async () => {
        renderer!.update(<ChatMarkdown cwd={undefined} text={diagram} />);
      });
      expect(imageSources(renderer!)).toEqual([src]);

      await act(async () => {
        renderer!.update(<ChatMarkdown cwd={undefined} text={`${diagram}\n\nMore prose.`} />);
      });
      expect(imageSources(renderer!)).toEqual([src]);
      expect(vi.mocked(renderMermaidImage).mock.calls).toEqual([
        ["flowchart TD\n  A --> B\n", "dark"],
      ]);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("leaves unclosed and non-Mermaid fences as code in a completed message", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(renderMermaidImage).mockReset().mockResolvedValue({ ok: true, src });
    let renderer: ReactTestRenderer | undefined;
    try {
      for (const text of [
        "```mermaid\nflowchart TD\n  A --> B",
        "````mermaid\nflowchart TD\n```",
        "```text\nflowchart TD\n  A --> B\n```",
      ]) {
        await act(async () => {
          renderer = create(<ChatMarkdown cwd={undefined} text={text} />);
        });
        expect([text, imageSources(renderer!)]).toEqual([text, []]);
        await act(async () => renderer?.unmount());
      }
      expect(renderMermaidImage).not.toHaveBeenCalled();

      await act(async () => {
        renderer = create(<ChatMarkdown cwd={undefined} text={"~~~Mermaid\ngraph LR\n~~~"} />);
      });
      expect(imageSources(renderer!)).toEqual([src]);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("toggles between diagram and source, and copy always copies the source", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.mocked(renderMermaidImage).mockReset().mockResolvedValue({ ok: true, src });
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd={undefined} text={diagram} />);
      });
      await act(async () => {
        codeButton(renderer!, "Copy code").onClick?.({} as never);
      });
      await act(async () => {
        codeButton(renderer!, "Show source").onClick?.({} as never);
      });
      expect([imageSources(renderer!), showsSource(renderer!)]).toEqual([[], true]);

      await act(async () => {
        codeButton(renderer!, "Show diagram").onClick?.({} as never);
      });
      expect(imageSources(renderer!)).toEqual([src]);
      expect(writeText.mock.calls).toEqual([["flowchart TD\n  A --> B\n"]]);
      expect(renderer!.root.findByType("img").props["data-markdown-copy"]).toBe(
        "```mermaid\nflowchart TD\n  A --> B\n```\n\n",
      );
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("waits to render a diagram until it scrolls into view", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let reportIntersection = (_isIntersecting: boolean) => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          reportIntersection = (isIntersecting) => callback([{ isIntersecting }]);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.mocked(renderMermaidImage).mockReset().mockResolvedValue({ ok: true, src });
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd={undefined} text={diagram} />, {
          createNodeMock: () => ({}),
        });
      });
      await act(async () => reportIntersection(false));
      expect(imageSources(renderer!)).toEqual([]);

      await act(async () => reportIntersection(true));
      expect(imageSources(renderer!)).toEqual([src]);
      expect(renderMermaidImage).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("falls back to the source with a note when a diagram fails to render", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(renderMermaidImage).mockReset().mockResolvedValue({ ok: false });
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd={undefined} text={"```mermaid\nnot a diagram\n```"} />);
      });
      expect(imageSources(renderer!)).toEqual([]);
      expect(renderer!.root.findByProps({ role: "status" }).props.children).toBe(
        "This diagram could not be rendered. Showing its source.",
      );
      expect(showsSource(renderer!)).toBe(true);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});
