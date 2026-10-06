import type { CloudMachineKind, CloudMachineState } from "@t3tools/contracts";

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

const BOX_TITLE_NAME = BOX_STATUS_NAME.charAt(0).toUpperCase() + BOX_STATUS_NAME.slice(1);

/**
 * The banner for a cloud chat whose machine is waking or updating, with the time that machine
 * really takes: an E2B sandbox resumes in seconds, a Namespace Devbox boots, and a Namespace Mac is
 * restored onto a new machine. One its provider cannot start says whose side failed and when it
 * last tried. `eta` is that time alone, for a status too short for a sentence.
 */
export function cloudWakeNotice(
  state: Exclude<CloudMachineStatus, "asleep">,
  cloudMachine: CloudMachine | null | undefined,
): { readonly title: string; readonly description: string; readonly eta: string | null } {
  const machine = cloudMachine?.machine;
  if (state === "unavailable") {
    const provider = machine === undefined ? "The cloud provider" : PROVIDER_BY_MACHINE[machine];
    const failure = cloudMachine?.providerFailure;
    // @effect-diagnostics-next-line globalDate:off - the host's ISO time, said in local time.
    const lastTried = failure && new Date(failure.at);
    const time = lastTried?.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const retrying = `Retrying on its own${time ? `, last tried at ${time}` : ""}.`;
    // Only a failure the provider answered with is said to be on its side; a timeout may not be.
    return failure?.cause === "provider-unreachable"
      ? {
          title: `Couldn't reach ${provider} yet`,
          description: `It didn't answer when asked to start ${BOX_STATUS_NAME}. ${retrying}`,
          eta: "retrying",
        }
      : {
          title: `${provider} couldn't start ${BOX_STATUS_NAME} yet`,
          description: `The problem is on their side. ${retrying}`,
          eta: "retrying",
        };
  }
  if (state === "updating")
    return {
      title: `${BOX_TITLE_NAME} is updating`,
      description:
        "It moves to the latest version, then reconnects on its own. This usually takes a few minutes.",
      eta: "a few minutes",
    };
  switch (machine) {
    case "sandbox":
      return {
        title: `${BOX_TITLE_NAME} is waking up`,
        description: "This usually takes about 10 seconds.",
        eta: "about 10 seconds",
      };
    case "mac":
      return {
        title: "Restoring this chat's Mac",
        description: "This takes about 2 minutes. It reconnects on its own.",
        eta: "about 2 minutes",
      };
    case "devbox":
      return {
        title: `${BOX_TITLE_NAME} is starting`,
        description: "This usually takes a minute or two.",
        eta: "a minute or two",
      };
    case undefined:
      return {
        title: `${BOX_TITLE_NAME} is waking up`,
        description: "It reconnects on its own.",
        eta: null,
      };
  }
}
