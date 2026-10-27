import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type ButtonProps = { label: string; disabled?: boolean; onPress: () => void };

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, disabled, onPress }: ButtonProps) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
const boxManager = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => boxManager.id }));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("../../state/server", () => ({ serverEnvironment: { switchProvisionedAccount: {} } }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { updateMetadata: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { UsageLimitRecoveryCard } from "./UsageLimitRecoveryCard";

const DAY_MS = 24 * 60 * 60 * 1000;

function failedThread(resetAt: string): EnvironmentThreadShell {
  return {
    id: "thread-1",
    updatedAt: new Date(0).toISOString(),
    snoozedUntil: null,
    latestRun: { runId: "run-1", completedAt: new Date(0).toISOString() },
    limitRecovery: null,
    runtime: { status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: resetAt },
  } as unknown as EnvironmentThreadShell;
}

describe("UsageLimitRecoveryCard", () => {
  it("disables Snooze once a reset more than 24.8 days away passes", () => {
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers({ now: 0 });
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    act(() =>
      root.render(
        <UsageLimitRecoveryCard
          thread={failedThread(new Date(30 * DAY_MS).toISOString())}
          environmentId={"env-1" as EnvironmentId}
        />,
      ),
    );
    const snooze = () =>
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Snooze until reset",
      );
    expect(snooze()?.disabled).toBe(false);

    act(() => vi.advanceTimersByTime(30 * DAY_MS));

    expect(snooze()?.disabled).toBe(true);
  });

  it("offers Switch account only on a cloud box", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    const render = () =>
      act(() =>
        root.render(
          <UsageLimitRecoveryCard
            thread={failedThread(new Date(DAY_MS).toISOString())}
            environmentId={"env-1" as EnvironmentId}
          />,
        ),
      );
    const labels = () => [...container.querySelectorAll("button")].map((b) => b.textContent);
    render();
    expect(labels()).not.toContain("Switch account");
    boxManager.id = "manager-1";
    using _box = { [Symbol.dispose]: () => (boxManager.id = null) };
    render();
    expect(labels()).toContain("Switch account");
  });
});
