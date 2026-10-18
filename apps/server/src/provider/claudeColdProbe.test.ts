import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { makeClaudeHostProbe } from "./Drivers/claudeHostProbe.ts";
import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
import { claudeProbeTimeToLive, parseClaudeAuthStatusOutput } from "./claudeColdProbe.ts";

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
    const status = yield* checkClaudeProviderStatus(defaultClaudeSettings, () =>
      hostProbe.readCapabilities(Effect.fail(new Cause.TimeoutError())),
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

it("keeps a probe for the TTL only when it is fresh and read its usage", () => {
  const ttl = claudeProbeTimeToLive(Duration.minutes(5));
  const usage = { rate_limits_available: true };
  assert.deepStrictEqual(
    [
      ttl(Exit.succeed({ _tag: "fresh", capabilities: { usage } })),
      ttl(Exit.succeed({ _tag: "fresh", capabilities: {} })),
      ttl(Exit.succeed({ _tag: "fallback", capabilities: { usage } })),
      ttl(Exit.fail("probe failed")),
    ].map(Duration.toMillis),
    [300_000, 0, 0, 0],
  );
});
