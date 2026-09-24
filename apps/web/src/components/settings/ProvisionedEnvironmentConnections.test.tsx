import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DiscoveredProvisionedEnvironment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { ProvisionedEnvironmentConnections } from "./ProvisionedEnvironmentConnections";

const state = vi.hoisted(() => ({
  rows: [] as ReadonlyArray<DiscoveredProvisionedEnvironment>,
  title: null as string | null,
  error: null as string | null,
  refresh: vi.fn(),
  attach: vi.fn(),
  resume: vi.fn(),
  pair: vi.fn(),
  navigate: vi.fn(),
  wait: vi.fn(),
  copy: vi.fn(),
  managerHttpBaseUrl: null as string | null,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ environmentControl: true }) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../connection/onboarding", () => ({ connectPairing: "pair" }));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => (state.title ? { title: state.title } : null),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  useEnvironmentHttpBaseUrl: () => state.managerHttpBaseUrl,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.rows,
    error: state.error,
    isPending: false,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => "config",
    provisionedEnvironments: () => "discovery",
    attachProvisionedEnvironment: "attach",
    resumeProvisionedEnvironment: "resume",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "attach" ? state.attach : command === "resume" ? state.resume : state.pair,
}));
vi.mock("../../state/waitForThreadShell", () => ({
  waitForThreadShell: (...args: unknown[]) => state.wait(...args),
}));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/qr-code", () => ({
  QRCodeSvg: ({ value, title }: { value: string; title?: string }) => (
    <img alt={title ?? "pairing link"} src={value} />
  ),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: state.copy, isCopied: false }),
}));
const environment = Schema.decodeSync(DiscoveredProvisionedEnvironment)({
  requestId: "11111111-1111-4111-a111-111111111111",
  leaseId: "11111111-1111-4111-a111-111111111112",
  sandboxId: "sandbox-1",
  lifecycle: "active",
  environmentId: "remote",
  provider: "e2b",
  label: "proof/repo",
  repository: "proof/repo",
  projectDir: "/private/project",
  threadId: "existing-thread",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
});
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [environment];
  state.title = null;
  state.error = null;
  state.managerHttpBaseUrl = null;
  state.attach.mockResolvedValue(
    AsyncResult.success({
      kind: "attached",
      environmentId: "remote",
      pairingUrl: "https://remote.invalid/pair#token=fresh",
    }),
  );
  state.pair.mockResolvedValue(AsyncResult.success(environment.environmentId));
  state.wait.mockResolvedValue(true);
  state.resume.mockResolvedValue(AsyncResult.success({ kind: "resumed" }));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});
const mount = async () => {
  await act(async () => {
    renderer = create(
      <ProvisionedEnvironmentConnections
        managerId={environment.environmentId}
        managerLabel="Local manager"
      />,
    );
  });
  return renderer!;
};
const click = async (view: ReactTestRenderer, label: string) => {
  const button = view.root
    .findAllByType("button")
    .find((candidate) => candidate.children.join("") === label);
  expect(button, `no button labelled ${label}`).toBeDefined();
  await act(async () => button?.props.onClick());
};
const attached = (pairingUrl: string) =>
  AsyncResult.success({ kind: "attached", environmentId: "remote", pairingUrl });
const paragraphs = (view: ReactTestRenderer) =>
  view.root.findAllByType("p").map((paragraph) => paragraph.children.join(""));

it("shows a manager-created environment without a composer draft and opens its stable thread", async () => {
  const view = await mount();
  expect(view.root.findAllByType("p").map((p) => p.children.join(""))).toContain("proof/repo");
  expect(state.refresh).toHaveBeenCalledOnce();
  const open = view.root
    .findAllByType("button")
    .find((button) => button.children.join("") === "Open thread");
  expect(open).toBeDefined();
  await act(async () => {
    open?.props.onClick();
  });
  expect(state.attach).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { requestId: environment.requestId },
    showsOwnProgress: true,
  });
  expect(state.pair).toHaveBeenCalledWith({
    pairingUrl: "https://remote.invalid/pair#token=fresh",
    expectedEnvironmentId: environment.environmentId,
  });
  expect(state.wait).toHaveBeenCalledWith({ environmentId: "remote", threadId: "existing-thread" });
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "remote", threadId: "existing-thread" },
  });
});
it("shows the remote thread title and repository after connection", async () => {
  state.title = "Fix failed summary";
  const view = await mount();
  expect(view.root.findAllByType("p").map((p) => p.children.join(""))).toContain(
    "Fix failed summary",
  );
  expect(view.root.findAllByType("p").some((p) => p.children.join("").includes("proof/repo"))).toBe(
    true,
  );
});

it("resumes a paused environment and routes its pairing through the manager", async () => {
  state.rows = [{ ...environment, lifecycle: "paused" }];
  state.managerHttpBaseUrl = "https://manager.invalid/base/";
  state.attach.mockResolvedValue(attached("http://127.0.0.1:50766/pair#token=fresh"));
  const view = await mount();
  await click(view, "Open thread");
  expect(state.resume).toHaveBeenCalledWith({
    environmentId: environment.environmentId,
    input: { environmentId: environment.environmentId },
    showsOwnProgress: true,
  });
  expect(state.pair).toHaveBeenCalledWith({
    pairingUrl:
      "https://manager.invalid/base/api/provisioned-environment/11111111-1111-4111-a111-111111111112/pair#token=fresh",
    expectedEnvironmentId: environment.environmentId,
  });
});
it("keeps attachment refusal visible without pairing or navigation", async () => {
  state.attach.mockResolvedValue(
    AsyncResult.success({ kind: "refused", message: "This lease has ended." }),
  );
  const view = await mount();
  await act(async () =>
    view.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Open thread")
      ?.props.onClick(),
  );
  expect(view.root.findByProps({ role: "status" }).children).toContain("This lease has ended.");
  expect(state.pair).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});

it("shares a scannable pairing link for a machine reachable off this computer", async () => {
  const view = await mount();
  await click(view, "Pair device");
  expect(state.attach).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { requestId: environment.requestId },
    showsOwnProgress: true,
  });
  expect(view.root.findByType("img").props.src).toBe("https://remote.invalid/pair#token=fresh");
  await click(view, "Copy link");
  expect(state.copy.mock.calls[0]?.[0]).toBe("https://remote.invalid/pair#token=fresh");
  expect(state.pair).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});
it("rewrites a manager-local pairing link before showing the device QR", async () => {
  state.managerHttpBaseUrl = "https://manager.invalid/base/";
  state.attach.mockResolvedValue(attached("http://127.0.0.1:50766/pair#token=fresh"));
  const view = await mount();
  await click(view, "Pair device");
  const pairingUrl =
    "https://manager.invalid/base/api/provisioned-environment/11111111-1111-4111-a111-111111111112/pair#token=fresh";
  expect(view.root.findByType("img").props.src).toBe(pairingUrl);
  await click(view, "Copy link");
  expect(state.copy.mock.calls[0]?.[0]).toBe(pairingUrl);
});
it("mints a fresh pairing link every time the panel is opened", async () => {
  state.attach
    .mockResolvedValueOnce(attached("https://remote.invalid/pair#token=first"))
    .mockResolvedValueOnce(attached("https://remote.invalid/pair#token=second"));
  const view = await mount();
  await click(view, "Pair device");
  await click(view, "Pair device");
  await click(view, "Pair device");
  expect(state.attach).toHaveBeenCalledTimes(2);
  expect(view.root.findByType("img").props.src).toBe("https://remote.invalid/pair#token=second");
});
it("explains that a machine reachable only through this computer cannot pair a device", async () => {
  state.attach.mockResolvedValue(attached("http://127.0.0.1:50766/pair#token=grant"));
  const view = await mount();
  await click(view, "Pair device");
  expect(view.root.findAllByType("img")).toHaveLength(0);
  expect(paragraphs(view)).toContain(
    "This machine is reachable only through this computer. Another device cannot use a pairing link for it.",
  );
});
it("keeps a refused pairing link visible without a QR", async () => {
  state.attach.mockResolvedValue(
    AsyncResult.success({ kind: "refused", message: "This lease has ended." }),
  );
  const view = await mount();
  await click(view, "Pair device");
  expect(view.root.findAllByType("img")).toHaveLength(0);
  expect(paragraphs(view)).toContain("This lease has ended.");
});
