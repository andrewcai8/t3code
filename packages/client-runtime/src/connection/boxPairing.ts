import type {
  DiscoveredProvisionedEnvironment,
  EnvironmentId,
  EnvironmentProvisionAttachResult,
  ProvisionRequestId,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { BearerConnectionRegistration } from "./catalog.ts";
import { workspaceMissingError } from "./errors.ts";
import {
  type BoxAttachment,
  type ConnectionAttemptError,
  ConnectionBlockedError,
  ConnectionTransientError,
} from "./model.ts";
import type { PairingConnectionInput } from "./onboarding.ts";
import { provisionedGatewayPairingUrl } from "./provisioned.ts";

/** Turns a minted pairing URL into this device's registration for the server behind it. */
export class PairingRedemption extends Context.Service<
  PairingRedemption,
  {
    readonly redeem: (
      input: PairingConnectionInput,
    ) => Effect.Effect<BearerConnectionRegistration, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/connection/boxPairing/PairingRedemption") {}

export interface BoxPairingPorts {
  /** How the box's host lists it now; none when the host does not list it. */
  readonly lookUp: Effect.Effect<
    Option.Option<DiscoveredProvisionedEnvironment>,
    ConnectionAttemptError
  >;
  readonly attach: (
    requestId: ProvisionRequestId,
  ) => Effect.Effect<EnvironmentProvisionAttachResult, ConnectionAttemptError>;
  /** The address this client reaches the host by; none until the host connection is prepared. */
  readonly hostHttpBaseUrl: Effect.Effect<Option.Option<string>>;
  readonly redeem: PairingRedemption["Service"]["redeem"];
}

/**
 * Where this client can redeem a pairing its host minted. A public origin (E2B) is used as
 * minted. A loopback origin (Namespace) answers only on the host, so it is reached through the
 * host's gateway at the address this client already dials the host by, and works wherever the
 * host does. Null while that address is unknown.
 */
export function reachablePairingUrl(
  minted: string,
  hostHttpBaseUrl: Option.Option<string>,
  leaseId: string,
): string | null {
  let hostname: string;
  try {
    hostname = new URL(minted).hostname;
  } catch {
    // Redeeming an unparseable URL reports why it cannot pair.
    return minted;
  }
  if (!isLoopbackHost(hostname)) return minted;
  return Option.match(hostHttpBaseUrl, {
    onNone: () => null,
    onSome: (host) => provisionedGatewayPairingUrl(host, leaseId, minted),
  });
}

/**
 * Obtains this device's pairing for a box through the host that provisioned it. A paused box
 * fails `not-serving`, so the dial wakes it and pairs on its next attempt. A box the host no
 * longer has is a missing workspace.
 */
export const pairBoxThroughHost = Effect.fn("BoxPairing.pairBoxThroughHost")(function* (
  box: { readonly environmentId: EnvironmentId } & BoxAttachment,
  ports: BoxPairingPorts,
) {
  const row = Option.getOrNull(yield* ports.lookUp);
  if (row === null || row.lifecycle === "missing" || row.lifecycle === "disposed")
    return yield* workspaceMissingError();
  if (row.lifecycle === "paused")
    return yield* new ConnectionTransientError({
      reason: "not-serving",
      detail: "This chat's cloud machine is asleep.",
    });
  const attached = yield* ports.attach(row.requestId);
  if (attached.kind === "refused")
    return yield* new ConnectionTransientError({
      reason: "remote-unavailable",
      detail: attached.message,
    });
  if (attached.environmentId !== box.environmentId)
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "The cloud host issued a connection for another environment.",
    });
  const pairingUrl = reachablePairingUrl(
    attached.pairingUrl,
    yield* ports.hostHttpBaseUrl,
    row.leaseId,
  );
  if (pairingUrl === null)
    return yield* new ConnectionTransientError({
      reason: "remote-unavailable",
      detail: "This chat's cloud host is not connected yet.",
    });
  return yield* ports.redeem({
    pairingUrl,
    expectedEnvironmentId: box.environmentId,
    box: { managerId: box.managerId },
  });
});
