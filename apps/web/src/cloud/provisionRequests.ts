import {
  EnvironmentId,
  EnvironmentProvisionInput,
  type EnvironmentProvisionResult,
  type EnvironmentProvisionDisposeResult,
  ProvisionRequestId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { randomUUID } from "../lib/utils";

const DraftProvisionRequest = Schema.Struct({
  managerEnvironmentId: EnvironmentId,
  input: EnvironmentProvisionInput,
  cancelRequested: Schema.optional(Schema.Boolean),
});
type DraftProvisionRequest = typeof DraftProvisionRequest.Type;
const DraftProvisionRequests = Schema.Record(Schema.String, DraftProvisionRequest);
const decodeRequests = Schema.decodeUnknownSync(Schema.fromJsonString(DraftProvisionRequests));
const decodeRequest = Schema.decodeUnknownSync(DraftProvisionRequest);
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(DraftProvisionRequest));
const encodeRequests = Schema.encodeSync(Schema.fromJsonString(DraftProvisionRequests));
const STORAGE_KEY = "t3code:draft-provision-requests:v1";
const DISPOSAL_STORAGE_KEY = "t3code:draft-provision-disposals:v1";
const cancellationListeners = new Set<() => void>();

const DraftProvisionDisposal = Schema.Struct({
  draftId: Schema.String,
  request: DraftProvisionRequest,
});
const DraftProvisionDisposals = Schema.Array(DraftProvisionDisposal);
const decodeDisposals = Schema.decodeUnknownSync(Schema.fromJsonString(DraftProvisionDisposals));
const encodeDisposals = Schema.encodeSync(Schema.fromJsonString(DraftProvisionDisposals));

function readStorageItem(key: string): string | null {
  try {
    if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") {
      return null;
    }
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readRequests() {
  const stored = readStorageItem(STORAGE_KEY);
  return stored === null ? {} : decodeRequests(stored);
}

function readDisposals() {
  const stored = readStorageItem(DISPOSAL_STORAGE_KEY);
  return stored === null ? [] : decodeDisposals(stored);
}

function notifyProvisionCancellations() {
  for (const listener of cancellationListeners) listener();
}

function enqueueDisposal(draftId: string, request: DraftProvisionRequest) {
  localStorage.setItem(
    DISPOSAL_STORAGE_KEY,
    encodeDisposals([...readDisposals(), { draftId, request }]),
  );
}

function forgetDisposal(draftId: string, requestId: string): void {
  const remaining = readDisposals().filter(
    (pending) => pending.draftId !== draftId || pending.request.input.requestId !== requestId,
  );
  if (remaining.length === 0) {
    localStorage.removeItem(DISPOSAL_STORAGE_KEY);
    return;
  }
  localStorage.setItem(DISPOSAL_STORAGE_KEY, encodeDisposals(remaining));
}

export function reserveProvisionRequest(
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
          : ProvisionRequestId.make(randomUUID()),
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
  localStorage.setItem(STORAGE_KEY, encodeRequests({ ...requests, [draftId]: candidate }));
  if (existing?.cancelRequested) notifyProvisionCancellations();
  return candidate;
}

export function forgetProvisionRequest(draftId: string): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return true;
    const requests = { ...decodeRequests(stored) };
    delete requests[draftId];
    localStorage.setItem(STORAGE_KEY, encodeRequests(requests));
    return true;
  } catch {
    return false;
  }
}

export function isProvisionRequestActive(draftId: string): boolean {
  const request = readRequests()[draftId];
  return request !== undefined && !request.cancelRequested;
}

export function isProvisionRequestCurrent(draftId: string, requestId: string): boolean {
  const request = readRequests()[draftId];
  return request !== undefined && !request.cancelRequested && request.input.requestId === requestId;
}

export function cancelProvisionRequest(draftId: string): void {
  const requests = readRequests();
  const request = requests[draftId];
  if (!request || request.cancelRequested) return;
  localStorage.setItem(
    STORAGE_KEY,
    encodeRequests({
      ...requests,
      [draftId]: { ...request, cancelRequested: true },
    }),
  );
  notifyProvisionCancellations();
}

export function subscribeProvisionCancellations(listener: () => void): () => void {
  cancellationListeners.add(listener);
  return () => {
    cancellationListeners.delete(listener);
  };
}

export async function drainProvisionCancellations(
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
    ...readDisposals().map((pending) => ({ ...pending, stored: "disposal" as const })),
  ];
  for (const { draftId, request, stored } of pending) {
    try {
      const result = await dispose(request);
      if (result?.kind !== "disposed") continue;
      if (stored === "disposal") {
        forgetDisposal(draftId, request.input.requestId);
      } else {
        forgetProvisionRequest(draftId);
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

function waitForProvisionRetry(draftId: string, requestId: string): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = globalThis.setTimeout(finish, 2_000);
    const unsubscribe = subscribeProvisionCancellations(() => {
      if (!isProvisionRequestCurrent(draftId, requestId)) finish();
    });
    if (!isProvisionRequestCurrent(draftId, requestId)) finish();
  });
}

/** Must match ProvisionControl's in-progress pending message. */
export const PROVISION_IN_PROGRESS_MESSAGE =
  "The environment is still being prepared. Retry the same request to continue.";

function shouldKeepPolling(result: EnvironmentProvisionResult | null): boolean {
  if (result === null) return true;
  if (result.kind === "allocation_unknown") return true;
  return result.kind === "pending" && result.message === PROVISION_IN_PROGRESS_MESSAGE;
}

export async function pollProvisionRequest(
  draftId: string,
  request: DraftProvisionRequest,
  dispatch: (request: DraftProvisionRequest) => Promise<EnvironmentProvisionResult | null>,
): Promise<EnvironmentProvisionResult | { kind: "cancelled" } | { kind: "unreachable" }> {
  let result: EnvironmentProvisionResult | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!isProvisionRequestCurrent(draftId, request.input.requestId)) {
      return { kind: "cancelled" };
    }
    try {
      result = await dispatch(request);
    } catch {
      result = null;
    }
    if (!isProvisionRequestCurrent(draftId, request.input.requestId)) {
      return { kind: "cancelled" };
    }
    if (result?.kind === "ready" || result?.kind === "refused") return result;
    if (!shouldKeepPolling(result) && result !== null) return result;
    if (attempt < 59) await waitForProvisionRetry(draftId, request.input.requestId);
  }
  return result ?? { kind: "unreachable" };
}
