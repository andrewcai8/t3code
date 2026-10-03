import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeHostProbe } from "../Drivers/claudeHostProbe.ts";
import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
import { getProbeDroppingFailedUsage, parseClaudeAuthStatusOutput } from "./claudeColdProbe.ts";

const defaultClaudeSettings = Schema.decodeSync(ClaudeSettings)({});
const encoder = new TextEncoder();

const claudeCli = (authStatus: string) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const joined = (command as unknown as { args: ReadonlyArray<string> }).args.join(" ");
      const stdout =
        joined === "--version" ? "2.1.200\n" : joined === "auth status" ? authStatus : "";
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

it("parses claude auth status JSON with a top-level email", () => {
  assert.deepEqual(
    parseClaudeAuthStatusOutput(
      'Logged in as user@example.com\n{"loggedIn":true,"email":"user@example.com","subscriptionType":"max","authMethod":"claude.ai"}\n',
    ),
    {
      loggedIn: true,
      email: "user@example.com",
      subscriptionType: "max",
      authMethod: "claude.ai",
    },
  );
});

it("parses nested account.email from older claude auth status fixtures", () => {
  assert.deepEqual(
    parseClaudeAuthStatusOutput(
      '{"loggedIn":true,"authMethod":"claude.ai","account":{"email":"claude@example.com"}}',
    ),
    { loggedIn: true, email: "claude@example.com", authMethod: "claude.ai" },
  );
});

it("returns undefined for non-JSON claude auth status output", () => {
  assert.equal(parseClaudeAuthStatusOutput("Not logged in"), undefined);
});

it.effect("reports a logged-in account as ready when the SDK probe returns nothing", () =>
  Effect.gen(function* () {
    const hostProbe = yield* makeClaudeHostProbe(defaultClaudeSettings, process.env, undefined);
    const nothingProbed = yield* Cache.make({
      capacity: 1,
      timeToLive: "5 minutes",
      lookup: () => Effect.succeed(undefined),
    });
    const status = yield* checkClaudeProviderStatus(defaultClaudeSettings, () =>
      hostProbe.readCapabilities(nothingProbed, "claude"),
    );
    assert.strictEqual(status.status, "ready");
    assert.deepStrictEqual(status.auth, {
      status: "authenticated",
      email: "user@example.com",
      type: "maxplan",
      label: "Claude Max Subscription",
    });
    assert.strictEqual(status.usageLimits?.unavailable?.reason, "probeFailed");
  }).pipe(
    Effect.provide(
      Layer.merge(
        NodeServices.layer,
        claudeCli(
          '{"loggedIn":true,"email":"user@example.com","subscriptionType":"maxplan","authMethod":"claude.ai"}\n',
        ),
      ),
    ),
  ),
);

it.effect("keeps a probe in the cache only when its usage read succeeded", () =>
  Effect.gen(function* () {
    const lookups = yield* Ref.make(0);
    const readTwice = Effect.fn(function* (usage: { readonly read: true } | undefined) {
      yield* Ref.set(lookups, 0);
      const cache = yield* Cache.make({
        capacity: 1,
        timeToLive: "5 minutes",
        lookup: (): Effect.Effect<{ readonly usage: typeof usage } | undefined> =>
          Ref.update(lookups, (count) => count + 1).pipe(Effect.as({ usage })),
      });
      yield* getProbeDroppingFailedUsage(cache, "claude");
      yield* getProbeDroppingFailedUsage(cache, "claude");
      return yield* Ref.get(lookups);
    });

    assert.strictEqual(yield* readTwice(undefined), 2);
    assert.strictEqual(yield* readTwice({ read: true }), 1);
  }),
);
