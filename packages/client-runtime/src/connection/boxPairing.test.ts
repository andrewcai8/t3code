import {
  DiscoveredProvisionedEnvironment,
  EnvironmentId,
  type EnvironmentProvisionAttachResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type BoxPairingPorts, pairBoxThroughHost, reachablePairingUrl } from "./boxPairing.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
} from "./catalog.ts";
import type { PairingConnectionInput } from "./onboarding.ts";
import { BearerConnectionTarget } from "./model.ts";

const HOST_ID = EnvironmentId.make("host");
const BOX_ID = EnvironmentId.make("box");
const decodeListed = Schema.decodeUnknownSync(DiscoveredProvisionedEnvironment);

function listed(lifecycle: DiscoveredProvisionedEnvironment["lifecycle"]) {
  return decodeListed({
    requestId: "11111111-1111-4111-a111-111111111111",
    leaseId: "lease-1",
    sandboxId: "sandbox-1",
    lifecycle,
    environmentId: BOX_ID,
    provider: "e2b",
    label: "t3code · E2B",
    repository: "pingdotgg/t3code",
    projectDir: "/workspace/t3code",
    threadId: "thread-1",
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-10-02T00:00:00.000Z",
  });
}

const PAIRED = new BearerConnectionRegistration({
  target: new BearerConnectionTarget({
    environmentId: BOX_ID,
    label: "e2b.local",
    connectionId: "bearer:box",
    box: { managerId: HOST_ID },
  }),
  profile: new BearerConnectionProfile({
    connectionId: "bearer:box",
    environmentId: BOX_ID,
    label: "e2b.local",
    httpBaseUrl: "https://3773-sandbox.e2b.app",
    wsBaseUrl: "wss://3773-sandbox.e2b.app",
  }),
  credential: new BearerConnectionCredential({ token: "box-token" }),
});

function pairing(input: {
  readonly row: DiscoveredProvisionedEnvironment | null;
  readonly attached?: EnvironmentProvisionAttachResult;
  readonly hostHttpBaseUrl?: string;
}) {
  const attaches: Array<string> = [];
  const redeemed: Array<PairingConnectionInput> = [];
  const ports: BoxPairingPorts = {
    lookUp: Effect.succeed(Option.fromNullOr(input.row)),
    attach: (requestId) =>
      Effect.sync(() => {
        attaches.push(requestId);
        const minted: EnvironmentProvisionAttachResult = input.attached ?? {
          kind: "attached",
          environmentId: BOX_ID,
          pairingUrl: "https://3773-sandbox.e2b.app/pair#token=minted",
        };
        return minted;
      }),
    hostHttpBaseUrl: Effect.succeed(Option.fromUndefinedOr(input.hostHttpBaseUrl)),
    redeem: (pairingInput) =>
      Effect.sync(() => {
        redeemed.push(pairingInput);
        return PAIRED;
      }),
  };
  return {
    attaches,
    redeemed,
    run: pairBoxThroughHost({ environmentId: BOX_ID, managerId: HOST_ID }, ports),
  };
}

describe("reachablePairingUrl", () => {
  it("keeps a public box origin as minted", () => {
    expect(
      reachablePairingUrl(
        "https://3773-sandbox.e2b.app/pair#token=X",
        Option.some("https://host.example.test"),
        "lease-1",
      ),
    ).toBe("https://3773-sandbox.e2b.app/pair#token=X");
  });

  it("reaches a loopback origin through the host at the address this client dials it by", () => {
    expect(
      reachablePairingUrl(
        "http://127.0.0.1:50766/pair#token=X",
        Option.some("https://host.example.test/"),
        "lease-1",
      ),
    ).toBe("https://host.example.test/api/provisioned-environment/lease-1/pair#token=X");
    expect(
      reachablePairingUrl(
        "http://127.0.0.1:50766/pair#token=X",
        Option.some("http://127.0.0.1:3773"),
        "lease-1",
      ),
    ).toBe("http://127.0.0.1:3773/api/provisioned-environment/lease-1/pair#token=X");
  });

  it("has no address for a loopback origin until the host connection is prepared", () => {
    expect(
      reachablePairingUrl("http://localhost:50766/pair#token=X", Option.none(), "lease-1"),
    ).toBeNull();
  });
});

describe("pairBoxThroughHost", () => {
  it.effect("attaches an active box once and redeems its pairing as this box of its host", () =>
    Effect.gen(function* () {
      const { attaches, redeemed, run } = pairing({ row: listed("active") });
      expect(yield* run).toEqual(PAIRED);
      expect(attaches).toEqual(["11111111-1111-4111-a111-111111111111"]);
      expect(redeemed).toEqual([
        {
          pairingUrl: "https://3773-sandbox.e2b.app/pair#token=minted",
          expectedEnvironmentId: "box",
          box: { managerId: "host" },
        },
      ]);
    }),
  );

  it.effect("redeems a Namespace box's loopback pairing through its host's gateway", () =>
    Effect.gen(function* () {
      const { redeemed, run } = pairing({
        row: listed("active"),
        attached: {
          kind: "attached",
          environmentId: BOX_ID,
          pairingUrl: "http://127.0.0.1:50766/pair#token=minted",
        },
        hostHttpBaseUrl: "https://host.example.test",
      });
      yield* run;
      expect(redeemed.map(({ pairingUrl }) => pairingUrl)).toEqual([
        "https://host.example.test/api/provisioned-environment/lease-1/pair#token=minted",
      ]);
    }),
  );

  it.effect("says a paused box is not serving, so the dial wakes it, without attaching", () =>
    Effect.gen(function* () {
      const { attaches, run } = pairing({ row: listed("paused") });
      const error = yield* Effect.flip(run);
      expect([error._tag, error.reason, error.detail]).toEqual([
        "ConnectionTransientError",
        "not-serving",
        "This chat's cloud machine is asleep.",
      ]);
      expect(attaches).toEqual([]);
    }),
  );

  it.effect(
    "says a listed box whose attach finds it not serving is not serving, so the dial wakes it",
    () =>
      Effect.gen(function* () {
        const { redeemed, run } = pairing({
          row: listed("active"),
          attached: {
            kind: "refused",
            reason: "not-serving",
            message: "This chat's cloud machine is not serving. Wake it first.",
          },
        });
        const error = yield* Effect.flip(run);
        expect([error._tag, error.reason, error.detail]).toEqual([
          "ConnectionTransientError",
          "not-serving",
          "This chat's cloud machine is not serving. Wake it first.",
        ]);
        expect(redeemed).toEqual([]);
      }),
  );

  it.effect("blocks a box its host no longer has as a missing workspace", () =>
    Effect.gen(function* () {
      for (const row of [null, listed("missing"), listed("disposed")]) {
        const error = yield* Effect.flip(pairing({ row }).run);
        expect([error._tag, error.reason]).toEqual(["ConnectionBlockedError", "workspace-missing"]);
      }
    }),
  );

  it.effect("retries a refused attach, and blocks one that answers for another box", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        pairing({
          row: listed("active"),
          attached: { kind: "refused", message: "The environment is not ready." },
        }).run,
      );
      expect([refused._tag, refused.reason, refused.detail]).toEqual([
        "ConnectionTransientError",
        "remote-unavailable",
        "The environment is not ready.",
      ]);

      const other = yield* Effect.flip(
        pairing({
          row: listed("active"),
          attached: {
            kind: "attached",
            environmentId: EnvironmentId.make("other"),
            pairingUrl: "https://3773-sandbox.e2b.app/pair#token=minted",
          },
        }).run,
      );
      expect([other._tag, other.reason]).toEqual(["ConnectionBlockedError", "configuration"]);
    }),
  );

  it.effect("retries a loopback pairing while the host connection is not prepared", () =>
    Effect.gen(function* () {
      const { redeemed, run } = pairing({
        row: listed("active"),
        attached: {
          kind: "attached",
          environmentId: BOX_ID,
          pairingUrl: "http://127.0.0.1:50766/pair#token=minted",
        },
      });
      const error = yield* Effect.flip(run);
      expect([error._tag, error.reason]).toEqual([
        "ConnectionTransientError",
        "remote-unavailable",
      ]);
      expect(redeemed).toEqual([]);
    }),
  );
});
