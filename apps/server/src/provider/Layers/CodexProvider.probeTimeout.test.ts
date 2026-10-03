import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { checkCodexProviderStatus } from "./CodexProvider.ts";

const defaultCodexSettings = Schema.decodeSync(CodexSettings)({});

it.effect("reports ready when a slow Codex home answers the status probe after 29 seconds", () =>
  Effect.gen(function* () {
    const statusFiber = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
      Effect.sleep("29 seconds").pipe(
        Effect.as({
          version: "1.0.0",
          account: {
            account: {
              type: "chatgpt" as const,
              email: "test@example.com",
              planType: "pro" as const,
            },
            requiresOpenaiAuth: false,
          },
          models: [],
          skills: [],
        }),
      ),
    ).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("29 seconds");

    const status = yield* Fiber.join(statusFiber);
    assert.strictEqual(status.status, "ready");
    assert.strictEqual(status.version, "1.0.0");
  }).pipe(Effect.provide(NodeServices.layer)),
);
