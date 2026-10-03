import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  identicalProviderReadings,
  isAccountSpent,
  rankAccounts,
} from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("rankAccounts", () => {
  const checkedAt = "2026-09-03T11:55:00.000Z";
  const session = (usedPercent: number, resetsAt = "2026-09-03T14:00:00.000Z") =>
    ({ ...window, usedPercent, resetsAt }) as const;
  const weekly = (usedPercent: number, resetsAt = "2026-09-07T00:00:00.000Z") =>
    ({
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent,
      windowDurationMins: 10_080,
      resetsAt,
    }) as const;
  const unreset = (usedPercent: number) =>
    ({ id: "credits", kind: "monthly", label: "Credits", usedPercent }) as const;
  const pool = (id: string, usedPercent: number) =>
    ({
      id,
      kind: "monthly",
      label: id,
      usedPercent,
      resetsAt: "2026-09-30T00:00:00.000Z",
    }) as const;
  const account = (
    id: string,
    usageLimits?: ServerProvider["usageLimits"],
    driver = "claudeAgent",
  ) => ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    usageLimits,
  });
  const ids = (accounts: ReadonlyArray<{ instanceId: string }>) =>
    accounts.map((a) => a.instanceId);

  it("ranks by the tightest window, so an exhausted week loses to a busier session", () => {
    const ranked = rankAccounts(
      [
        account("weekly-spent", { checkedAt, windows: [session(10), weekly(97)] }),
        account("session-busy", { checkedAt, windows: [session(70), weekly(20)] }),
        account("fresh", { checkedAt, windows: [session(5), weekly(5)] }),
      ],
      now,
    );
    expect(ids(ranked)).toEqual(["fresh", "session-busy", "weekly-spent"]);
  });

  it("ranks a spent account below one whose usage is unknown", () => {
    const ranked = rankAccounts(
      [
        account("spent", { checkedAt, windows: [session(10), weekly(100)] }),
        account("unknown"),
        account("room", { checkedAt, windows: [session(90)] }),
      ],
      now,
    );
    expect(ids(ranked)).toEqual(["room", "unknown", "spent"]);
  });

  it("counts a window past its reset as full", () => {
    const ranked = rankAccounts(
      [
        account("half", { checkedAt, windows: [session(50)] }),
        account("reset", { checkedAt, windows: [session(100, "2026-09-03T11:00:00.000Z")] }),
      ],
      now,
    );
    expect(ids(ranked)).toEqual(["reset", "half"]);
  });

  it("ranks Cursor by its combined figure, which Auto draws down from either pool", () => {
    const ranked = rankAccounts(
      [
        account(
          "api-spent",
          {
            checkedAt,
            windows: [
              pool("totalPercentUsed", 40),
              pool("autoPercentUsed", 20),
              pool("apiPercentUsed", 100),
            ],
          },
          "cursor",
        ),
        account(
          "busier",
          {
            checkedAt,
            windows: [
              pool("totalPercentUsed", 70),
              pool("autoPercentUsed", 60),
              pool("apiPercentUsed", 80),
            ],
          },
          "cursor",
        ),
        account("unknown", undefined, "cursor"),
      ],
      now,
    );
    expect(ids(ranked)).toEqual(["api-spent", "busier", "unknown"]);
  });

  it("without Cursor's combined figure, ranks on the roomier pool", () => {
    const ranked = rankAccounts(
      [
        account(
          "auto-left",
          { checkedAt, windows: [pool("autoPercentUsed", 70), pool("apiPercentUsed", 100)] },
          "cursor",
        ),
        account(
          "both-spent",
          { checkedAt, windows: [pool("autoPercentUsed", 100), pool("apiPercentUsed", 100)] },
          "cursor",
        ),
        account(
          "api-left",
          { checkedAt, windows: [pool("autoPercentUsed", 100), pool("apiPercentUsed", 50)] },
          "cursor",
        ),
      ],
      now,
    );
    expect(ids(ranked)).toEqual(["api-left", "auto-left", "both-spent"]);
  });

  it("puts API keys at full headroom and unknown accounts last", () => {
    const ranked = rankAccounts(
      [
        account("failed", { checkedAt, windows: [], unavailable: { reason: "probeFailed" } }),
        account("unreported"),
        account("used", { checkedAt, windows: [session(99), weekly(99)] }),
        account("api-key", { checkedAt, windows: [], unavailable: { reason: "unsupported" } }),
      ],
      now,
    );
    expect(ids(ranked)).toEqual(["api-key", "used", "failed", "unreported"]);
  });

  it("ranks an old reading by what it said, unless it saw a spent window with no reset", () => {
    const old = "2026-09-03T10:50:00.000Z";
    const ranked = rankAccounts(
      [
        account("old-spent", { checkedAt: old, windows: [session(10), weekly(100)] }),
        account("unreported"),
        account("old-busy", { checkedAt: old, windows: [session(60)] }),
        account("old-refilled", {
          checkedAt: old,
          windows: [session(100, "2026-09-03T11:30:00.000Z")],
        }),
        account("fresh-unreset", { checkedAt, windows: [unreset(100)] }),
        account("old-idle", { checkedAt: old, windows: [session(10)] }),
        account("old-unreset", { checkedAt: old, windows: [unreset(100)] }),
        account("fresh-busy", { checkedAt, windows: [session(95)] }),
      ],
      now,
      ProviderInstanceId.make("unreported"),
    );
    expect(ids(ranked)).toEqual([
      "old-refilled",
      "old-idle",
      "old-busy",
      "fresh-busy",
      "unreported",
      "old-unreset",
      "old-spent",
      "fresh-unreset",
    ]);
  });

  it("counts a window that refills early in a long job as nearly full", () => {
    const ranked = rankAccounts(
      [
        account("spent-until-soon", {
          checkedAt,
          windows: [session(100, "2026-09-03T12:05:00.000Z")],
        }),
        account("refills-late", { checkedAt, windows: [session(95, "2026-09-03T16:00:00.000Z")] }),
        account("half-left-all-week", { checkedAt, windows: [weekly(50)] }),
        account("refills-soon", { checkedAt, windows: [session(95, "2026-09-03T12:10:00.000Z")] }),
        account("runs-dry-first", {
          checkedAt,
          windows: [session(99, "2026-09-03T12:30:00.000Z")],
        }),
      ],
      now,
    );
    expect(ids(ranked)).toEqual([
      "refills-soon",
      "half-left-all-week",
      "runs-dry-first",
      "refills-late",
      "spent-until-soon",
    ]);
  });

  it("pools accounts whose readings match exactly as one subscription", () => {
    const shared = { checkedAt, windows: [weekly(40)] };
    const ranked = rankAccounts(
      [
        account("a", shared),
        account("b", shared),
        account("c", shared),
        account("d", { checkedAt, windows: [weekly(55)] }),
      ],
      now,
      undefined,
      new Map([[ProviderInstanceId.make("a"), 1]]),
    );
    expect(ids(ranked)).toEqual(["d", "a", "b", "c"]);
  });

  it("calls an account spent on an old reading only while that window has not reset", () => {
    const old = "2026-09-03T10:50:00.000Z";
    const claude = ProviderDriverKind.make("claudeAgent");
    expect(
      [
        { checkedAt: old, windows: [weekly(100)] },
        { checkedAt: old, windows: [session(100, "2026-09-03T11:30:00.000Z")] },
        { checkedAt: old, windows: [unreset(100)] },
        { checkedAt, windows: [unreset(100)] },
        { checkedAt: old, windows: [weekly(100), unreset(100)] },
      ].map((limits) => isAccountSpent(claude, limits, now)),
    ).toEqual([true, false, false, true, true]);
  });

  it("breaks ties by earliest refill, then the preferred account, then id", () => {
    const ranked = rankAccounts(
      [
        account("c", { checkedAt, windows: [session(40)] }),
        account("b", { checkedAt, windows: [session(40)] }),
        account("late", { checkedAt, windows: [weekly(40)] }),
        account("a", { checkedAt, windows: [session(40)] }),
        account("soon", { checkedAt, windows: [session(40, "2026-09-03T12:30:00.000Z")] }),
      ],
      now,
      ProviderInstanceId.make("c"),
    );
    expect(ids(ranked)).toEqual(["soon", "c", "a", "b", "late"]);
  });

  describe("with active sessions", () => {
    const load = (entries: Record<string, number>) =>
      new Map(Object.entries(entries).map(([id, active]) => [ProviderInstanceId.make(id), active]));

    it("shares what is left with the sessions already on an account", () => {
      const busy = account("a", { checkedAt, windows: [session(20)] });
      const idle = account("b", { checkedAt, windows: [session(50)] });
      expect(ids(rankAccounts([busy, idle], now, undefined, load({ a: 3, b: 0 })))).toEqual([
        "b",
        "a",
      ]);
      expect(ids(rankAccounts([busy, idle], now))).toEqual(["a", "b"]);
    });

    it("sends the new chat to the idle account when usage left is equal", () => {
      const ranked = rankAccounts(
        [
          account("a", { checkedAt, windows: [weekly(40)] }),
          account("b", { checkedAt, windows: [weekly(40, "2026-09-08T00:00:00.000Z")] }),
        ],
        now,
        ProviderInstanceId.make("a"),
        load({ a: 2 }),
      );
      expect(ids(ranked)).toEqual(["b", "a"]);
    });

    it("ranks unknown accounts by fewest active sessions", () => {
      const ranked = rankAccounts(
        [account("a"), account("b"), account("c")],
        now,
        undefined,
        load({ a: 2, b: 1 }),
      );
      expect(ids(ranked)).toEqual(["c", "b", "a"]);
    });

    it("keeps an idle spent account below a busy one with room left", () => {
      const ranked = rankAccounts(
        [
          account("spent", { checkedAt, windows: [session(100)] }),
          account("nearly", { checkedAt, windows: [session(99)] }),
        ],
        now,
        undefined,
        load({ spent: 0, nearly: 5 }),
      );
      expect(ids(ranked)).toEqual(["nearly", "spent"]);
    });
  });
});

describe("one Claude account across machines", () => {
  const claude = ProviderDriverKind.make("claudeAgent");
  const weekly = {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
    resetsAt: "2026-09-06T12:00:00.000Z",
  } as const;
  const reading = (instanceId: string, email: string, checkedAt: string, usedPercent: number) =>
    provider({
      driver: claude,
      instanceId: ProviderInstanceId.make(instanceId),
      displayName: `Claude · ${email}`,
      auth: { status: "authenticated", email },
      usageLimits: {
        checkedAt,
        windows: [
          { ...window, usedPercent },
          { ...weekly, usedPercent: 30 },
        ],
      },
    });
  const machines = new Map([
    [
      EnvironmentId.make("mac"),
      {
        entry: { target: { label: "Mac" } },
        serverConfig: {
          providers: [reading("claude_work", "work@example.com", "2026-09-03T11:00:00.000Z", 20)],
        },
      },
    ],
    [
      EnvironmentId.make("host"),
      {
        entry: { target: { label: "Host" } },
        serverConfig: {
          providers: [reading("claude_work", "Work@Example.com", "2026-09-03T11:40:00.000Z", 45)],
        },
      },
    ],
    [
      EnvironmentId.make("box"),
      {
        entry: { target: { label: "Box" } },
        serverConfig: {
          providers: [reading("claudeAgent", "work@example.com", "2026-09-03T11:20:00.000Z", 30)],
        },
      },
    ],
  ]);

  it("collapses the Mac, host and box rows for one email into one, the freshest reading on show", () => {
    const accounts = collectLimitAccounts(machines);
    expect(accounts.map((account) => account.environments.map(({ label }) => label))).toEqual([
      ["Mac", "Host", "Box"],
    ]);
    expect(accounts[0]?.limits.windows.map(({ usedPercent }) => usedPercent)).toEqual([45, 30]);
  });

  it("pools the account once, so its reading is not averaged in three times", () => {
    const [pool] = collectLimitPools(collectLimitAccounts(machines), now);
    expect(pool?.accounts).toHaveLength(1);
    expect(
      pool?.windows.map(({ id, members, remainingPercent }) => [
        id,
        members.length,
        remainingPercent,
      ]),
    ).toEqual([
      ["five_hour", 1, 55],
      ["seven_day", 1, 70],
    ]);
  });
});

describe("cloud boxes in Limits", () => {
  const claude = ProviderDriverKind.make("claudeAgent");
  const reading = (
    instanceId: string,
    email: string,
    reported: { readonly email: boolean; readonly checkedAt: string; readonly weeklyUsed: number },
  ) =>
    provider({
      driver: claude,
      instanceId: ProviderInstanceId.make(instanceId),
      displayName: `Claude · ${email}`,
      auth: reported.email ? { status: "authenticated", email } : { status: "authenticated" },
      usageLimits: {
        checkedAt: reported.checkedAt,
        windows: [
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: reported.weeklyUsed,
            windowDurationMins: 7 * 24 * 60,
            resetsAt: "2026-10-01T11:00:00.000Z",
          },
        ],
      },
    });
  const environment = (label: string, providers: ServerProvider[]) => ({
    entry: { target: { label } },
    serverConfig: { providers },
  });
  // A box made before its host recorded account emails runs the routed account
  // as `claudeAgent` under the same name, and its setup token cannot name it.
  // A paused box still shows the reading its client cached.
  const presentations = new Map([
    [
      EnvironmentId.make("mac"),
      environment("Mac", [
        reading("claude_shanghai11167", "shanghai11167@gmail.com", {
          email: true,
          checkedAt: "2026-09-28T06:55:47.000Z",
          weeklyUsed: 22,
        }),
        reading("claude_dustowl321", "dustowl321@gmail.com", {
          email: true,
          checkedAt: "2026-09-28T06:55:42.000Z",
          weeklyUsed: 0,
        }),
      ]),
    ],
    [
      EnvironmentId.make("host"),
      environment("andrew.megpt.app", [
        reading("claude_shanghai11167", "shanghai11167@gmail.com", {
          email: true,
          checkedAt: "2026-09-28T06:52:59.000Z",
          weeklyUsed: 22,
        }),
        reading("claude_dustowl321", "dustowl321@gmail.com", {
          email: true,
          checkedAt: "2026-09-28T06:52:59.000Z",
          weeklyUsed: 0,
        }),
      ]),
    ],
    [
      EnvironmentId.make("live-box"),
      environment("authentic-intelligence/megpt-mono", [
        reading("claudeAgent", "shanghai11167@gmail.com", {
          email: false,
          checkedAt: "2026-09-28T06:54:02.000Z",
          weeklyUsed: 22,
        }),
      ]),
    ],
    [
      EnvironmentId.make("paused-box"),
      environment("authentic-intelligence/megpt-mono", [
        reading("claudeAgent", "dustowl321@gmail.com", {
          email: false,
          checkedAt: "2026-09-27T07:30:00.000Z",
          weeklyUsed: 0,
        }),
      ]),
    ],
  ]);
  // Clients list user environments only, so a box never reaches Limits.
  const userEnvironments = new Map(
    [...presentations].filter(([environmentId]) => !environmentId.endsWith("-box")),
  );

  it("counts each account once, from the machines that own it", () => {
    const accounts = collectLimitAccounts(userEnvironments);
    expect(
      accounts.map((account) => [account.email, account.environments.map(({ label }) => label)]),
    ).toEqual([
      ["shanghai11167@gmail.com", ["Mac", "andrew.megpt.app"]],
      ["dustowl321@gmail.com", ["Mac", "andrew.megpt.app"]],
    ]);
  });

  it("would show a box's anonymous copy as another account", () => {
    expect(
      collectLimitAccounts(presentations).map((account) => [
        account.displayName,
        account.environments.map(({ label }) => label),
      ]),
    ).toEqual([
      ["Claude · shanghai11167@gmail.com", ["Mac", "andrew.megpt.app"]],
      ["Claude · dustowl321@gmail.com", ["Mac", "andrew.megpt.app"]],
      ["Claude · shanghai11167@gmail.com", ["authentic-intelligence/megpt-mono"]],
      ["Claude · dustowl321@gmail.com", ["authentic-intelligence/megpt-mono"]],
    ]);
  });
});

describe("identical readings", () => {
  const claude = ProviderDriverKind.make("claudeAgent");
  const checkedAt = "2026-09-03T11:00:00.000Z";
  const weekly = {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    usedPercent: 62,
    windowDurationMins: 7 * 24 * 60,
    resetsAt: "2026-09-06T12:00:00.000Z",
  } as const;
  const instance = (email: string, sessionUsed: number) =>
    provider({
      driver: claude,
      instanceId: ProviderInstanceId.make(`claude_${email.split("@")[0]}`),
      displayName: `Claude · ${email}`,
      auth: { status: "authenticated", email },
      usageLimits: { checkedAt, windows: [{ ...window, usedPercent: sessionUsed }, weekly] },
    });
  const host = (providers: ServerProvider[]) =>
    new Map([
      [
        EnvironmentId.make("host"),
        { entry: { target: { label: "Host" } }, serverConfig: { providers } },
      ],
    ]);

  it("flags four accounts reading the same numbers, and not two that differ", () => {
    const providers = [
      instance("a@example.com", 40),
      instance("b@example.com", 40),
      instance("c@example.com", 40),
      instance("d@example.com", 40),
      instance("e@example.com", 12),
      instance("f@example.com", 77),
    ];
    expect(identicalProviderReadings(providers)).toEqual([
      [
        "Claude · a@example.com",
        "Claude · b@example.com",
        "Claude · c@example.com",
        "Claude · d@example.com",
      ],
    ]);
    expect(collectLimitNotices(host(providers))).toEqual([
      "Claude · a@example.com, Claude · b@example.com, Claude · c@example.com, Claude · d@example.com report identical limits, so they may be one account.",
    ]);
  });

  it("compares only windows with a reset, flagging a shared week and not fresh or idle accounts", () => {
    const idleSession = (email: string, weekUsed: number, weekResets = weekly.resetsAt) =>
      provider({
        ...instance(email, 0),
        usageLimits: {
          checkedAt,
          windows: [
            { ...window, usedPercent: 0, resetsAt: undefined },
            { ...weekly, usedPercent: weekUsed, resetsAt: weekResets },
          ],
        },
      });
    const fresh = (email: string) =>
      provider({
        ...instance(email, 0),
        usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 0, resetsAt: undefined }] },
      });
    expect(
      identicalProviderReadings([
        idleSession("a@example.com", 62),
        idleSession("b@example.com", 62),
        idleSession("c@example.com", 0),
        idleSession("d@example.com", 0),
        fresh("e@example.com"),
        fresh("f@example.com"),
      ]),
    ).toEqual([["Claude · a@example.com", "Claude · b@example.com"]]);
  });

  it("does not flag one account seen by name on the Mac and anonymously on the host", () => {
    const mac = instance("a@example.com", 40);
    const anonymous = { ...mac, auth: { status: "authenticated" as const } };
    expect(
      collectLimitNotices(
        new Map([
          [
            EnvironmentId.make("mac"),
            { entry: { target: { label: "Mac" } }, serverConfig: { providers: [mac] } },
          ],
          [
            EnvironmentId.make("host"),
            { entry: { target: { label: "Host" } }, serverConfig: { providers: [anonymous] } },
          ],
        ]),
      ),
    ).toEqual([]);
  });

  it("does not flag one email reported by two instances, or untouched accounts", () => {
    const same = instance("a@example.com", 40);
    const fresh = (email: string) =>
      provider({
        ...instance(email, 0),
        usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 0, resetsAt: undefined }] },
      });
    expect(
      identicalProviderReadings([
        same,
        { ...same, instanceId: ProviderInstanceId.make("claude_again") },
        fresh("x@example.com"),
        fresh("y@example.com"),
      ]),
    ).toEqual([]);
  });
});

describe("rankAccounts across instances of one account", () => {
  const checkedAt = "2026-09-03T11:55:00.000Z";
  const account = (id: string, email: string | undefined, usedPercent: number) => ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("claudeAgent"),
    email,
    usageLimits: { checkedAt, windows: [{ ...window, usedPercent }] },
  });

  it("counts sessions on either instance of one email against both", () => {
    const load = new Map([[ProviderInstanceId.make("work"), 3]]);
    const ranked = rankAccounts(
      [
        account("work", "work@example.com", 20),
        account("work_again", "Work@example.com", 20),
        account("home", "home@example.com", 50),
      ],
      now,
      undefined,
      load,
    );
    // 80% left over four sessions is 20 each, below home's 50 over one.
    expect(ranked.map(({ instanceId }) => instanceId)).toEqual(["home", "work", "work_again"]);
  });
});
