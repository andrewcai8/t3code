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
  pair: vi.fn(),
  navigate: vi.fn(),
  wait: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ environmentControl: true }) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../connection/onboarding", () => ({ connectPairing: "pair" }));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => (state.title ? { title: state.title } : null),
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
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
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "attach" ? state.attach : state.pair),
}));
vi.mock("../../state/waitForThreadShell", () => ({
  waitForThreadShell: (...args: unknown[]) => state.wait(...args),
}));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
const environment = Schema.decodeSync(DiscoveredProvisionedEnvironment)({
  requestId: "11111111-1111-4111-a111-111111111111",
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
  state.attach.mockResolvedValue(
    AsyncResult.success({
      kind: "attached",
      environmentId: "remote",
      pairingUrl: "https://remote.invalid/pair#token=fresh",
    }),
  );
  state.pair.mockResolvedValue(AsyncResult.success(environment.environmentId));
  state.wait.mockResolvedValue(true);
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
