import type { CloudMachineKind, CloudMachineState } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { cloudProviderVendor } from "../cloud/provisioning.ts";
import { workspaceMissingError } from "./boxErrors.ts";
import { type ConnectionTarget, connectionBox } from "./model.ts";
import type { EnvironmentConnectionPresentation } from "./presentation.ts";
import type { CloudMachine } from "./registryBoxes.ts";

/** What a cloud box is called in status copy. */
export const BOX_STATUS_NAME = "this chat's cloud machine";

/**
 * What status copy calls a connection, mid-sentence. A box's saved label names the first machine
 * it ran on and goes stale when the box moves, so a box is named by its role.
 */
export function connectionStatusName(target: ConnectionTarget): string {
  return connectionBox(target) === null ? target.label : BOX_STATUS_NAME;
}

/** A saved workspace marked missing reads as removed whatever its supervisor is doing. */
export function presentMissingWorkspace(
  target: ConnectionTarget | undefined,
): EnvironmentConnectionPresentation | null {
  return target?._tag === "BearerConnectionTarget" && target.workspaceStatus === "missing"
    ? {
        phase: "error",
        error: workspaceMissingError().message,
        traceId: null,
        blockedReason: "workspace-missing",
      }
    : null;
}

/** A cloud machine's state as its row and banner say it: `unavailable` while its provider cannot start it. */
export type CloudMachineStatus = CloudMachineState | "unavailable";

/**
 * What a cloud chat's machine is doing, for its row and banner. This client's own connection
 * decides first: connected is awake. A machine its provider keeps failing to start says so through
 * every retry. Otherwise this client's wake is one, or an update its host reports, and the host's
 * last answer decides the rest. Null for an awake machine or anything else.
 */
export function cloudMachineStatus(
  machine: CloudMachine | undefined,
  phase: EnvironmentConnectionPresentation["phase"] | undefined,
): CloudMachineStatus | null {
  if (phase === "connected") return null;
  if (machine?.providerFailure !== undefined) return "unavailable";
  if (phase === "waking") return machine?.state === "updating" ? "updating" : "waking";
  return machine?.state ?? null;
}

const PROVIDER_BY_MACHINE: Record<CloudMachineKind, string> = {
  sandbox: "E2B",
  devbox: "Namespace",
  mac: "Namespace",
};

/**
 * The banner for a cloud chat whose machine is waking or updating, with the time that machine
 * really takes: an E2B sandbox resumes in seconds, a Namespace Devbox boots, and a Namespace Mac is
 * restored onto a new machine. One its provider cannot start says whose side failed and when it
 * last tried. `eta` is that time alone, for a status too short for a sentence.
 */
export function cloudWakeNotice(
  state: Exclude<CloudMachineStatus, "asleep">,
  cloudMachine: CloudMachine | null | undefined,
  resolve: MFunctionType = mFallback,
): { readonly title: string; readonly description: string; readonly eta: string | null } {
  const machine = cloudMachine?.machine;
  if (state === "unavailable") {
    const provider = cloudMachine?.provider
      ? cloudProviderVendor(cloudMachine.provider)
      : machine === undefined
        ? resolve(msg("The cloud provider"))
        : PROVIDER_BY_MACHINE[machine];
    const failure = cloudMachine?.providerFailure;
    // @effect-diagnostics-next-line globalDate:off - the host's ISO time, said in local time.
    const lastTried = failure && new Date(failure.at);
    const time = lastTried?.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const retrying = time
      ? resolve(msg("Retrying on its own, last tried at {time}.", { time }))
      : resolve(msg("Retrying on its own."));
    const eta = resolve(msg("retrying", { $context: "cloud machine start status" }));
    // Only a failure the provider answered with is said to be on its side; a timeout may not be.
    return failure?.cause === "provider-unreachable"
      ? {
          title: resolve(msg("Couldn't reach {provider} yet", { provider })),
          description: resolve(
            msg("It didn't answer when asked to start this chat's cloud machine. {retrying}", {
              retrying,
            }),
          ),
          eta,
        }
      : {
          title: resolve(
            msg("{provider} couldn't start this chat's cloud machine yet", { provider }),
          ),
          description: resolve(msg("The problem is on their side. {retrying}", { retrying })),
          eta,
        };
  }
  if (state === "updating")
    return {
      title: resolve(msg("This chat's cloud machine is updating")),
      description: resolve(
        msg(
          "It moves to the latest version, then reconnects on its own. This usually takes a few minutes.",
        ),
      ),
      eta: resolve(msg("a few minutes")),
    };
  switch (machine) {
    case "sandbox":
      return {
        title: resolve(msg("This chat's cloud machine is waking up")),
        description: resolve(msg("This usually takes about 10 seconds.")),
        eta: resolve(msg("about 10 seconds")),
      };
    case "mac":
      return {
        title: resolve(msg("Restoring this chat's Mac")),
        description: resolve(msg("This takes about 2 minutes. It reconnects on its own.")),
        eta: resolve(msg("about 2 minutes")),
      };
    case "devbox":
      return {
        title: resolve(msg("This chat's cloud machine is starting")),
        description: resolve(msg("This usually takes a minute or two.")),
        eta: resolve(msg("a minute or two")),
      };
    case undefined:
      return {
        title: resolve(msg("This chat's cloud machine is waking up")),
        description: resolve(msg("It reconnects on its own.")),
        eta: null,
      };
  }
}
