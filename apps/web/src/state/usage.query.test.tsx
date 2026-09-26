import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useUsage, type UsageView } from "./usage";

const testState = vi.hoisted(() => ({ asked: [] as string[] }));

vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./presentation", async () => {
  const { Atom: TestAtom } = await import("effect/unstable/reactivity");
  const { EnvironmentId: TestEnvironmentId } = await import("@t3tools/contracts");
  return {
    environmentPresentations: {
      presentationsAtom: TestAtom.make(
        new Map(
          ["a", "b"].map((id) => [
            TestEnvironmentId.make(id),
            { entry: { target: { label: id } }, connection: { phase: "connected" } },
          ]),
        ),
      ),
    },
  };
});
vi.mock("./server", () => ({
  serverEnvironment: {
    usageSummary: ({
      environmentId,
      input,
    }: {
      environmentId: EnvironmentId;
      input: UsageSummaryInput;
    }) => {
      testState.asked.push(environmentId);
      return Atom.make(AsyncResult.success(summary(environmentId, input)));
    },
    providersValueAtom: () => Atom.make([]),
  },
}));

const input: UsageSummaryInput = {
  sinceDay: UsageDay.make("2026-09-04"),
  untilDay: UsageDay.make("2026-09-04"),
  timeZone: "UTC",
};

function summary(environmentId: string, window: UsageSummaryInput): UsageSummary {
  return {
    ...window,
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-09-04T12:00:00Z",
    buckets: [
      {
        day: window.sinceDay,
        provider: "codex",
        model: environmentId,
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 50,
          reasoningTokens: 0,
        },
        costUsd: environmentId === "a" ? 10 : 20,
        cacheSavingsUsd: 0,
        costSource: "modelPriced",
        records: 1,
        unpricedRecords: 0,
        sessions: 1,
      },
    ],
    sources: [
      {
        fingerprint: {
          hostId: environmentId,
          provider: "codex",
          resolvedHomePath: "/sessions",
          volumeId: environmentId,
        },
        status: "ok",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
      },
    ],
    pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
  };
}

let renderer: ReactTestRenderer | undefined;
let latest: UsageView;

function Probe({ selected }: { selected: ReadonlySet<EnvironmentId> | null }) {
  const usage = useUsage(input, selected);
  useLayoutEffect(() => {
    latest = usage;
  }, [usage]);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.asked = [];
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("usage environment queries", () => {
  it("asks only selected environments for usage and still lists the rest", async () => {
    await act(() => {
      renderer = create(<Probe selected={new Set([EnvironmentId.make("b")])} />);
    });

    expect(testState.asked).toEqual(["b"]);
    expect(latest.merged.costUsd).toBe(20);
    expect(
      latest.environments.map((environment) => [environment.label, environment.summary !== null]),
    ).toEqual([
      ["a", false],
      ["b", true],
    ]);

    await act(() => renderer?.update(<Probe selected={null} />));
    expect(testState.asked).toContain("a");
    expect(latest.merged.costUsd).toBe(30);
  });
});
