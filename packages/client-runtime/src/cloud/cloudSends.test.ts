import {
  EnvironmentId,
  type EnvironmentProvisionResult,
  ProjectId,
  ProviderDriverKind,
  ProvisionRequestId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type CloudSendStep, createCloudSendDriver, createTabExclusive } from "./cloudSends.ts";
import { createProvisionRequestStore, PROVISION_IN_PROGRESS_MESSAGE } from "./provisionRequests.ts";
import { createProvisionedSandboxLeaseStore } from "./provisionedSandboxLeases.ts";
import type { ProvisionStorage } from "./storage.ts";

const draftId = "draft";
const managerEnvironmentId = EnvironmentId.make("manager");
const boxEnvironmentId = EnvironmentId.make("box");
const requestId = ProvisionRequestId.make("00000000-0000-4000-8000-000000000001");
const sendInput = {
  provider: "e2b" as const,
  providerInstanceId: "codex-account",
  agentDriver: ProviderDriverKind.make("codex"),
  repository: "example/repository",
};
const readyEnvironment = {
  environmentId: boxEnvironmentId,
  leaseId: "lease",
  provider: "e2b" as const,
  sandboxId: "sandbox",
  projectDir: "/workspace",
  providerInstanceId: "codex-account",
  sourceRevision: null,
  t3Revision: "a".repeat(40),
  artifactSha256: "b".repeat(64),
  control: {
    preparationRoot: "/prepared",
    brokerCredentialPath: "/prepared/credential",
    localT3Url: "http://localhost:3773",
    runtimeExecutable: "node",
    runtimeEntrypoint: "/prepared/t3/index.mjs",
  },
};
const ready: EnvironmentProvisionResult = {
  kind: "ready",
  requestId,
  environment: readyEnvironment,
};
const inProgress: EnvironmentProvisionResult = {
  kind: "pending",
  requestId,
  message: PROVISION_IN_PROGRESS_MESSAGE,
};

function memoryStorage(): ProvisionStorage {
  const records = new Map<string, string>();
  return {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => {
      records.set(key, value);
    },
    removeItem: (key) => {
      records.delete(key);
    },
  };
}

function requestStore(storage: ProvisionStorage, randomUUID: () => string) {
  return createProvisionRequestStore({
    storage,
    randomUUID,
    // A retry fires as soon as the current step settles, so nothing waits on a clock.
    schedule: (callback) => {
      let scheduled = true;
      void Promise.resolve().then(() => {
        if (scheduled) callback();
      });
      return () => {
        scheduled = false;
      };
    },
  });
}

/**
 * One device: the storage every page on it shares, the lock manager they share, and the host
 * the draft's send went to. `host` answers each provision call in turn and repeats its last
 * answer; every call to the host, and every held message sent, is logged.
 */
function device(answers: ReadonlyArray<EnvironmentProvisionResult>) {
  const storage = memoryStorage();
  const exclusive = createTabExclusive();
  const hostCalls: string[] = [];
  const sent: string[] = [];
  let answered = 0;
  let requested = 0;
  // The first request has `requestId`; a replacement gets the next id.
  const randomUUID = () => `00000000-0000-4000-8000-00000000000${++requested}`;

  /** A page loading on this device, with nothing in memory but what storage holds. */
  function page(name: string) {
    const requests = requestStore(storage, randomUUID);
    const steps: string[] = [];
    const driver = createCloudSendDriver({
      requests,
      leases: createProvisionedSandboxLeaseStore(storage),
      exclusive,
      record: (id, step) => {
        steps.push(`${id}:${describeStep(step)}`);
      },
      host: (request) => ({
        provision: async (provisioned) => {
          hostCalls.push(`${name} provision ${provisioned.input.requestId}`);
          const answer = answers[Math.min(answered, answers.length - 1)]!;
          answered += 1;
          return answer;
        },
        attach: async (attached) => {
          hostCalls.push(`${name} attach ${attached.input.requestId}`);
          return {
            kind: "attached",
            environmentId: boxEnvironmentId,
            pairingUrl: `https://box.example/pair#manager=${request.managerEnvironmentId}`,
          };
        },
        pair: async (pairingUrl) => {
          hostCalls.push(`${name} pair ${pairingUrl}`);
          return boxEnvironmentId;
        },
        isConnected: () => false,
        canReach: () => true,
        waitForProject: async () => ProjectId.make("box-project"),
      }),
    });
    /** The held-message send a draft's view runs: a started turn forgets the request. */
    const sendHeld = () =>
      driver.sendHeld(draftId, async () => {
        sent.push(name);
        requests.forget(draftId);
      });
    return { driver, requests, steps, sendHeld };
  }

  /** A page that sent the draft's first message to the cloud, then closed mid-setup. */
  function sendThenClose() {
    requestStore(storage, randomUUID).reserve(draftId, { managerEnvironmentId, input: sendInput });
  }

  return { page, sendThenClose, hostCalls, sent };
}

function describeStep(step: CloudSendStep): string {
  switch (step.kind) {
    case "progress":
      return step.phase;
    case "ready":
      return `ready ${step.projectRef.environmentId}/${step.projectRef.projectId}`;
    case "failed":
      return `failed ${step.message}`;
    case "cancelled":
      return "cancelled";
  }
}

describe("createCloudSendDriver", () => {
  it("picks a reloaded mid-setup send back up and sends its held message once", async () => {
    const phone = device([inProgress, inProgress, ready]);
    phone.sendThenClose();
    const reloaded = phone.page("reloaded");

    const outcome = await reloaded.driver.resume(draftId);

    expect(outcome).toEqual({
      kind: "ready",
      projectRef: { environmentId: boxEnvironmentId, projectId: ProjectId.make("box-project") },
      firstTurnStarted: false,
    });
    expect(reloaded.steps).toEqual([
      "draft:creating",
      "draft:pairing",
      "draft:loading-project",
      "draft:ready box/box-project",
    ]);
    const sends = await Promise.all([reloaded.sendHeld(), reloaded.sendHeld()]);
    expect(phone.hostCalls).toEqual([
      `reloaded provision ${requestId}`,
      `reloaded provision ${requestId}`,
      `reloaded provision ${requestId}`,
      `reloaded attach ${requestId}`,
      "reloaded pair https://box.example/pair#manager=manager",
    ]);
    expect(sends).toEqual([true, false]);
    expect(phone.sent).toEqual(["reloaded"]);
  });

  it("shows ready at once when the host already finished the request", async () => {
    const phone = device([ready]);
    phone.sendThenClose();
    const reloaded = phone.page("reloaded");

    await reloaded.driver.resume(draftId);

    expect(reloaded.steps).toEqual([
      "draft:creating",
      "draft:pairing",
      "draft:loading-project",
      "draft:ready box/box-project",
    ]);
    expect(phone.hostCalls).toEqual([
      `reloaded provision ${requestId}`,
      `reloaded attach ${requestId}`,
      "reloaded pair https://box.example/pair#manager=manager",
    ]);
  });

  it("shows the reason a host recorded when it ended the request", async () => {
    const phone = device([
      {
        kind: "refused",
        reason: "disposed",
        message: "Setup made no progress for 45 minutes, so the machine was stopped.",
      },
    ]);
    phone.sendThenClose();
    const reloaded = phone.page("reloaded");

    await reloaded.driver.resume(draftId);

    expect(reloaded.steps).toEqual([
      "draft:creating",
      "draft:failed Setup made no progress for 45 minutes, so the machine was stopped.",
    ]);
    expect(phone.hostCalls).toEqual([`reloaded provision ${requestId}`]);
  });

  it("stops a picked-up send the user cancels, and never sends it", async () => {
    const phone = device([inProgress]);
    phone.sendThenClose();
    const reloaded = phone.page("reloaded");

    const outcome = reloaded.driver.resume(draftId);
    reloaded.requests.cancel(draftId);

    expect(await outcome).toEqual({ kind: "cancelled" });
    expect(reloaded.steps).toEqual(["draft:creating", "draft:cancelled"]);
    expect(await reloaded.sendHeld()).toBe(false);
    expect(phone.sent).toEqual([]);
    expect(phone.hostCalls).toEqual([`reloaded provision ${requestId}`]);
  });

  it("joins a send already under way on the page instead of starting a second", async () => {
    const phone = device([inProgress, ready]);
    const page = phone.page("page");

    const started = page.driver.start({ draftId, managerEnvironmentId, input: sendInput });
    const resumed = page.driver.resume(draftId);

    expect(await resumed).toBe(await started);
    expect(page.steps).toEqual([
      "draft:creating",
      "draft:pairing",
      "draft:loading-project",
      "draft:ready box/box-project",
    ]);
    expect(phone.hostCalls).toEqual([
      `page provision ${requestId}`,
      `page provision ${requestId}`,
      `page attach ${requestId}`,
      "page pair https://box.example/pair#manager=manager",
    ]);
  });

  it("sends the held message from one of two open tabs", async () => {
    const laptop = device([inProgress, ready]);
    laptop.sendThenClose();
    const first = laptop.page("first");
    const second = laptop.page("second");

    await Promise.all([first.driver.resume(draftId), second.driver.resume(draftId)]);
    const sends = await Promise.all([first.sendHeld(), second.sendHeld()]);

    expect(sends).toEqual([true, false]);
    expect(laptop.sent).toEqual(["first"]);
    expect(second.steps.at(-1)).toBe("draft:cancelled");
  });

  it("fails a picked-up send whose request is gone, keeping it to send again", async () => {
    const laptop = device([ready]);
    laptop.sendThenClose();
    laptop.page("other").requests.cancel(draftId);
    const reloaded = laptop.page("reloaded");

    await reloaded.driver.resume(draftId);

    expect(reloaded.steps).toEqual([
      "draft:failed Setup stopped before the environment was ready. Send again to start it.",
    ]);
    expect(laptop.hostCalls).toEqual([]);
  });

  it("leaves a send's steps to the request that replaced it", async () => {
    const phone = device([inProgress, inProgress, ready]);
    const page = phone.page("page");

    const first = page.driver.start({ draftId, managerEnvironmentId, input: sendInput });
    page.requests.cancel(draftId);
    const second = page.driver.start({
      draftId,
      managerEnvironmentId,
      input: { ...sendInput, branch: "feature" },
    });

    expect(await first).toEqual({ kind: "cancelled" });
    expect((await second).kind).toBe("ready");
    expect(page.steps).toEqual([
      "draft:creating",
      "draft:creating",
      "draft:pairing",
      "draft:loading-project",
      "draft:ready box/box-project",
    ]);
  });
});
