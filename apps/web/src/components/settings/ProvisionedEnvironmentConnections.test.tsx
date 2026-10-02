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
  refresh: vi.fn(),
  resume: vi.fn(),
  dispose: vi.fn(),
  keep: vi.fn(),
  confirm: vi.fn(),
  forget: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ environmentControl: true }) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../cloud/provisionedSandboxLeases", () => ({
  forgetProvisionedSandbox: (...args: unknown[]) => state.forget(...args),
}));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-03-01T12:00" }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => (state.title ? { title: state.title } : null),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.rows,
    error: null,
    isPending: false,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => "config",
    provisionedEnvironments: () => "discovery",
    resumeProvisionedEnvironment: "resume",
    disposeProvisionedEnvironment: "dispose",
    keepProvisionedEnvironment: "keep",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "resume" ? state.resume : command === "keep" ? state.keep : state.dispose,
}));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));

const machine = (lifecycle: DiscoveredProvisionedEnvironment["lifecycle"]) =>
  Schema.decodeSync(DiscoveredProvisionedEnvironment)({
    requestId: "11111111-1111-4111-a111-111111111111",
    leaseId: "11111111-1111-4111-a111-111111111112",
    sandboxId: "sandbox-1",
    lifecycle,
    environmentId: "box",
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
  state.rows = [machine("active")];
  state.title = null;
  state.resume.mockResolvedValue(AsyncResult.success({ kind: "resumed" }));
  state.dispose.mockResolvedValue(AsyncResult.success({ kind: "disposed" }));
  state.keep.mockResolvedValue(AsyncResult.success({ kind: "updated" }));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});
const mount = async () => {
  await act(async () => {
    renderer = create(
      <ProvisionedEnvironmentConnections
        managerId={"host" as never}
        managerLabel="andrew.megpt.app"
      />,
    );
  });
  return renderer!;
};
const buttons = (view: ReactTestRenderer) =>
  view.root.findAllByType("button").map((button) => button.children.join(""));
const click = async (view: ReactTestRenderer, label: string) => {
  const button = view.root
    .findAllByType("button")
    .find((candidate) => candidate.children.join("") === label);
  expect(button, `no button labelled ${label}`).toBeDefined();
  await act(async () => button?.props.onClick());
};
const paragraphs = (view: ReactTestRenderer) =>
  view.root.findAllByType("p").map((paragraph) => paragraph.children.join(""));

it("opens a machine through its chat when that chat is on this device, never by joining", async () => {
  state.title = "Fix the login flow";
  const view = await mount();
  expect(paragraphs(view)).toContain("Fix the login flow");
  expect(buttons(view)).toEqual(["Refresh", "Open chat", "Delete"]);
  await click(view, "Open chat");
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "box", threadId: "existing-thread" },
  });
});

it("offers no way in to a machine whose chat is on another device", async () => {
  const view = await mount();
  expect(paragraphs(view)).toContain("proof/repo");
  expect(buttons(view)).toEqual(["Refresh", "Delete"]);
});

it("resumes a paused machine through its host", async () => {
  state.rows = [machine("paused")];
  const view = await mount();
  await click(view, "Resume");
  expect(state.resume).toHaveBeenCalledWith({
    environmentId: "host",
    input: { environmentId: "box" },
  });
  expect(state.refresh).toHaveBeenCalledTimes(2);
});

it("deletes a machine through its host once confirmed, and forgets its lease", async () => {
  state.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const view = await mount();
  await click(view, "Delete");
  expect(state.dispose).not.toHaveBeenCalled();
  await click(view, "Delete");
  expect(state.dispose).toHaveBeenCalledWith({
    environmentId: "host",
    input: { requestId: "11111111-1111-4111-a111-111111111111" },
  });
  expect(state.forget).toHaveBeenCalledWith({ environmentId: "box", threadId: "existing-thread" });
});

it("keeps a refused delete visible", async () => {
  state.confirm.mockResolvedValue(true);
  state.dispose.mockResolvedValue(AsyncResult.success({ kind: "refused", message: "busy" }));
  const view = await mount();
  await click(view, "Delete");
  expect(paragraphs(view)).toContain("The host could not delete this machine.");
  expect(state.forget).not.toHaveBeenCalled();
});

it("shows when a paused machine will be removed and keeps it on request", async () => {
  state.rows = [
    {
      ...machine("paused"),
      cleanup: { kind: "scheduled", at: "2026-03-07T12:00:00.000Z", reason: "idle" },
    },
  ];
  const view = await mount();
  expect(paragraphs(view)).toContain("proof/repo · E2B · Paused · Removed in 6 days");
  await click(view, "Keep");
  expect(state.keep).toHaveBeenCalledWith({
    environmentId: "host",
    input: { requestId: "11111111-1111-4111-a111-111111111111", keep: true },
  });
});

it("allows cleanup again of a machine the user kept", async () => {
  state.rows = [{ ...machine("paused"), cleanup: { kind: "kept", reason: "user" } }];
  const view = await mount();
  expect(paragraphs(view)).toContain("proof/repo · E2B · Paused · Kept");
  await click(view, "Allow cleanup");
  expect(state.keep).toHaveBeenCalledWith({
    environmentId: "host",
    input: { requestId: "11111111-1111-4111-a111-111111111111", keep: false },
  });
});
