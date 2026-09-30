import type { DraftProvisionRequest } from "./provisionRequests.ts";
import {
  type CloudProvisionDraft,
  type CloudProvisionOutcome,
  type CloudProvisionPorts,
  type CloudProvisioningProgressPhase,
  provisionCloudEnvironment,
} from "./provisioning.ts";

/** Where a draft's cloud send has got to. `cancelled` means the send is over on this page. */
export type CloudSendStep =
  | { readonly kind: "progress"; readonly phase: CloudProvisioningProgressPhase }
  | CloudProvisionOutcome;

export interface CloudSendDriverPorts extends Pick<CloudProvisionPorts, "requests" | "leases"> {
  /** The calls one request makes, which depend on the host it went to. */
  readonly host: (
    request: DraftProvisionRequest,
  ) => Omit<CloudProvisionPorts, "requests" | "leases" | "onPhase">;
  /** Writes a step onto the draft; every view of the draft reads it from there. */
  readonly record: (draftId: string, step: CloudSendStep) => void;
  /** Runs `task` once no other page on this device holds `key`, holding it until `task` settles. */
  readonly exclusive: (key: string, task: () => Promise<boolean>) => Promise<boolean>;
}

/**
 * Drives a draft's cloud send from "Send" to its held message going out, from whichever page
 * has the draft. Everything it needs survives a reload: the draft's provision request says which
 * host and request to rejoin, and the draft's own record keeps the held message. So a page that
 * loads a draft mid-setup resumes it exactly as the page that sent it would have, and one page
 * running both a send and a resume joins them into one drive.
 */
export function createCloudSendDriver(ports: CloudSendDriverPorts) {
  const { requests } = ports;
  const drives = new Map<
    string,
    { readonly requestId: string; readonly outcome: Promise<CloudProvisionOutcome> }
  >();

  function drive(draftId: string, request: DraftProvisionRequest): Promise<CloudProvisionOutcome> {
    const running = drives.get(draftId);
    if (running?.requestId === request.input.requestId) return running.outcome;
    const { requestId, ...input } = request.input;
    const outcome = provisionCloudEnvironment(
      { draftId, managerEnvironmentId: request.managerEnvironmentId, input },
      {
        requests,
        leases: ports.leases,
        ...ports.host(request),
        onPhase: (phase) => ports.record(draftId, { kind: "progress", phase }),
      },
    ).then((result) => {
      if (drives.get(draftId)?.requestId === requestId) drives.delete(draftId);
      // A request cancelled and replaced leaves the draft to the replacement's drive.
      const live = requests.current(draftId);
      if (live === null || live.input.requestId === requestId) ports.record(draftId, result);
      return result;
    });
    drives.set(draftId, { requestId, outcome });
    return outcome;
  }

  /** Starts a draft's cloud send, or joins the drive already running for its request. */
  function start(draft: CloudProvisionDraft): Promise<CloudProvisionOutcome> {
    let request: DraftProvisionRequest;
    try {
      request = requests.reserve(draft.draftId, {
        managerEnvironmentId: draft.managerEnvironmentId,
        input: draft.input,
      });
    } catch (error) {
      const failed = {
        kind: "failed",
        message: error instanceof Error ? error.message : "Could not prepare the environment.",
      } as const;
      ports.record(draft.draftId, failed);
      return Promise.resolve(failed);
    }
    return drive(draft.draftId, request);
  }

  /**
   * Picks up a draft's send that no page is driving, such as one a reload cut off mid-setup.
   * With no live request to rejoin, the send fails and keeps its message to send again.
   */
  function resume(draftId: string): Promise<CloudProvisionOutcome> {
    const request = requests.current(draftId);
    if (request !== null) return drive(draftId, request);
    const stopped = {
      kind: "failed",
      message: "Setup stopped before the environment was ready. Send again to start it.",
    } as const;
    ports.record(draftId, stopped);
    return Promise.resolve(stopped);
  }

  /**
   * Sends a ready draft's held message at most once across every page on this device, and
   * resolves true when this page sent it. The live request is the proof it has not gone out: a
   * send that starts the turn forgets it and a cancel marks it, so a page that finds it gone
   * leaves the draft to the page that sent it.
   */
  function sendHeld(draftId: string, send: () => Promise<void>): Promise<boolean> {
    return ports.exclusive(`cloud-send:${draftId}`, async () => {
      if (!requests.isActive(draftId)) {
        ports.record(draftId, { kind: "cancelled" });
        return false;
      }
      await send();
      return true;
    });
  }

  return { start, resume, sendHeld };
}

export type CloudSendDriver = ReturnType<typeof createCloudSendDriver>;

/**
 * `CloudSendDriverPorts.exclusive` for one page: tasks under a key run one after another. Pages
 * that share a lock manager across tabs, such as the Web Locks API, use that instead.
 */
export function createTabExclusive(): CloudSendDriverPorts["exclusive"] {
  const tails = new Map<string, Promise<unknown>>();
  return (key, task) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}
