import {
  EnvironmentId,
  EnvironmentProvisionInput,
  type EnvironmentProvisionDisposeResult,
  type EnvironmentProvisionResult,
  ProvisionRequestId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProvisionStorage } from "./storage.ts";

const DraftProvisionRequest = Schema.Struct({
  managerEnvironmentId: EnvironmentId,
  input: EnvironmentProvisionInput,
  cancelRequested: Schema.optional(Schema.Boolean),
});
export type DraftProvisionRequest = typeof DraftProvisionRequest.Type;
const DraftProvisionRequests = Schema.Record(Schema.String, DraftProvisionRequest);
const decodeRequests = Schema.decodeUnknownSync(Schema.fromJsonString(DraftProvisionRequests));
const decodeRequest = Schema.decodeUnknownSync(DraftProvisionRequest);
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(DraftProvisionRequest));
const encodeRequests = Schema.encodeSync(Schema.fromJsonString(DraftProvisionRequests));

const DraftProvisionDisposal = Schema.Struct({
  draftId: Schema.String,
  request: DraftProvisionRequest,
});
const DraftProvisionDisposals = Schema.Array(DraftProvisionDisposal);
const decodeDisposals = Schema.decodeUnknownSync(Schema.fromJsonString(DraftProvisionDisposals));
const encodeDisposals = Schema.encodeSync(Schema.fromJsonString(DraftProvisionDisposals));

export const PROVISION_REQUESTS_STORAGE_KEY = "t3code:draft-provision-requests:v1";
export const PROVISION_DISPOSALS_STORAGE_KEY = "t3code:draft-provision-disposals:v1";

/** Must match ProvisionControl's in-progress pending message. */
export const PROVISION_IN_PROGRESS_MESSAGE =
  "The environment is still being prepared. Retry the same request to continue.";

const POLL_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 2_000;

export interface ProvisionRequestStorePorts {
  readonly storage: ProvisionStorage;
  readonly randomUUID: () => string;
  /** Runs `callback` after `delayMs`; calling the returned function cancels it. */
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

export type ProvisionPollResult =
  | EnvironmentProvisionResult
  | { readonly kind: "cancelled" }
  | { readonly kind: "unreachable" };

function shouldKeepPolling(result: EnvironmentProvisionResult | null): boolean {
  if (result === null) return true;
  if (result.kind === "allocation_unknown") return true;
  return result.kind === "pending" && result.message === PROVISION_IN_PROGRESS_MESSAGE;
}

/**
 * A draft owns at most one live provision request. The request is persisted before it is
 * dispatched, so a reload retries the same `requestId` and the manager answers idempotently
 * instead of allocating a second sandbox. Cancelling marks the record rather than deleting
 * it: the machine may already exist, and the record is what lets a later drain dispose it.
 */
export function createProvisionRequestStore(ports: ProvisionRequestStorePorts) {
  const { storage } = ports;
  const cancellationListeners = new Set<() => void>();

  function readRequests() {
    const stored = storage.getItem(PROVISION_REQUESTS_STORAGE_KEY);
    return stored === null ? {} : decodeRequests(stored);
  }

  function readDisposals() {
    const stored = storage.getItem(PROVISION_DISPOSALS_STORAGE_KEY);
    return stored === null ? [] : decodeDisposals(stored);
  }

  function notifyCancellations() {
    for (const listener of cancellationListeners) listener();
  }

  function enqueueDisposal(draftId: string, request: DraftProvisionRequest) {
    storage.setItem(
      PROVISION_DISPOSALS_STORAGE_KEY,
      encodeDisposals([...readDisposals(), { draftId, request }]),
    );
  }

  function forgetDisposal(draftId: string, requestId: string): void {
    const remaining = readDisposals().filter(
      (pending) => pending.draftId !== draftId || pending.request.input.requestId !== requestId,
    );
    if (remaining.length === 0) {
      storage.removeItem(PROVISION_DISPOSALS_STORAGE_KEY);
      return;
    }
    storage.setItem(PROVISION_DISPOSALS_STORAGE_KEY, encodeDisposals(remaining));
  }

  function reserve(
    draftId: string,
    request: {
      readonly managerEnvironmentId: EnvironmentId;
      readonly input: Omit<EnvironmentProvisionInput, "requestId">;
    },
  ): DraftProvisionRequest {
    const requests = readRequests();
    const existing = requests[draftId];
    if (existing?.cancelRequested) {
      enqueueDisposal(draftId, existing);
    }
    const candidate = decodeRequest({
      ...request,
      input: {
        ...request.input,
        requestId:
          existing && !existing.cancelRequested
            ? existing.input.requestId
            : ProvisionRequestId.make(ports.randomUUID()),
      },
    });
    if (existing && !existing.cancelRequested) {
      if (encodeRequest(candidate) !== encodeRequest(existing)) {
        throw new Error(
          "This draft already requested an environment. Retry its original provider and account, or start a new draft.",
        );
      }
      return existing;
    }
    storage.setItem(
      PROVISION_REQUESTS_STORAGE_KEY,
      encodeRequests({ ...requests, [draftId]: candidate }),
    );
    if (existing?.cancelRequested) notifyCancellations();
    return candidate;
  }

  function forget(draftId: string): boolean {
    try {
      const stored = storage.getItem(PROVISION_REQUESTS_STORAGE_KEY);
      if (stored === null) return true;
      const requests = { ...decodeRequests(stored) };
      delete requests[draftId];
      storage.setItem(PROVISION_REQUESTS_STORAGE_KEY, encodeRequests(requests));
      return true;
    } catch {
      return false;
    }
  }

  function isActive(draftId: string): boolean {
    const request = readRequests()[draftId];
    return request !== undefined && !request.cancelRequested;
  }

  function isCurrent(draftId: string, requestId: string): boolean {
    const request = readRequests()[draftId];
    return (
      request !== undefined && !request.cancelRequested && request.input.requestId === requestId
    );
  }

  function cancel(draftId: string): void {
    const requests = readRequests();
    const request = requests[draftId];
    if (!request || request.cancelRequested) return;
    storage.setItem(
      PROVISION_REQUESTS_STORAGE_KEY,
      encodeRequests({ ...requests, [draftId]: { ...request, cancelRequested: true } }),
    );
    notifyCancellations();
  }

  function subscribeCancellations(listener: () => void): () => void {
    cancellationListeners.add(listener);
    return () => {
      cancellationListeners.delete(listener);
    };
  }

  async function drainCancellations(
    dispose: (request: DraftProvisionRequest) => Promise<EnvironmentProvisionDisposeResult | null>,
  ): Promise<string[]> {
    const disposed: string[] = [];
    const pending: Array<{
      draftId: string;
      request: DraftProvisionRequest;
      stored: "draft" | "disposal";
    }> = [
      ...Object.entries(readRequests()).flatMap(([draftId, request]) =>
        request.cancelRequested ? [{ draftId, request, stored: "draft" as const }] : [],
      ),
      ...readDisposals().map((entry) => ({ ...entry, stored: "disposal" as const })),
    ];
    for (const { draftId, request, stored } of pending) {
      try {
        const result = await dispose(request);
        if (result?.kind !== "disposed") continue;
        if (stored === "disposal") {
          forgetDisposal(draftId, request.input.requestId);
        } else {
          forget(draftId);
        }
        const current = readRequests()[draftId];
        if (
          (!current || current.input.requestId === request.input.requestId) &&
          !disposed.includes(draftId)
        ) {
          disposed.push(draftId);
        }
      } catch {
        continue;
      }
    }
    return disposed;
  }

  function waitForRetry(draftId: string, requestId: string): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        cancelTimer();
        unsubscribe();
        resolve();
      };
      const cancelTimer = ports.schedule(finish, POLL_INTERVAL_MS);
      const unsubscribe = subscribeCancellations(() => {
        if (!isCurrent(draftId, requestId)) finish();
      });
      if (!isCurrent(draftId, requestId)) finish();
    });
  }

  /**
   * Re-dispatches the saved request until the manager reports ready or refuses. A cancel
   * wins immediately, even against a receipt already in flight, so a cancelled draft never
   * proceeds to pair with a machine it has asked to dispose.
   */
  async function poll(
    draftId: string,
    request: DraftProvisionRequest,
    dispatch: (request: DraftProvisionRequest) => Promise<EnvironmentProvisionResult | null>,
  ): Promise<ProvisionPollResult> {
    let result: EnvironmentProvisionResult | null = null;
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      if (!isCurrent(draftId, request.input.requestId)) return { kind: "cancelled" };
      try {
        result = await dispatch(request);
      } catch {
        result = null;
      }
      if (!isCurrent(draftId, request.input.requestId)) return { kind: "cancelled" };
      if (result?.kind === "ready" || result?.kind === "refused") return result;
      if (!shouldKeepPolling(result) && result !== null) return result;
      if (attempt < POLL_ATTEMPTS - 1) await waitForRetry(draftId, request.input.requestId);
    }
    return result ?? { kind: "unreachable" };
  }

  return {
    reserve,
    forget,
    isActive,
    isCurrent,
    cancel,
    subscribeCancellations,
    drainCancellations,
    poll,
  };
}

export type ProvisionRequestStore = ReturnType<typeof createProvisionRequestStore>;
