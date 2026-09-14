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
const cancellationListeners = new Set<() => void>();

function readRequests() {
  const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
  return stored === null ? {} : decodeRequests(stored);
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
  const candidate = decodeRequest({
    ...request,
    input: {
      ...request.input,
      requestId: existing?.input.requestId ?? ProvisionRequestId.make(randomUUID()),
    },
  });
  if (existing) {
    if (existing.cancelRequested) throw new Error("This environment request was cancelled.");
    if (encodeRequest(candidate) !== encodeRequest(existing)) {
      throw new Error(
        "This draft already requested an environment. Retry its original provider and account, or start a new draft.",
      );
    }
    return existing;
  }
  localStorage.setItem(STORAGE_KEY, encodeRequests({ ...requests, [draftId]: candidate }));
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
  for (const listener of cancellationListeners) listener();
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
  for (const [draftId, request] of Object.entries(readRequests())) {
    if (!request.cancelRequested) continue;
    try {
      const result = await dispose(request);
      if (result?.kind === "disposed") {
        forgetProvisionRequest(draftId);
        disposed.push(draftId);
      }
    } catch {
      continue;
    }
  }
  return disposed;
}

function waitForProvisionRetry(draftId: string): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = globalThis.setTimeout(finish, 2_000);
    const unsubscribe = subscribeProvisionCancellations(() => {
      if (!isProvisionRequestActive(draftId)) finish();
    });
    if (!isProvisionRequestActive(draftId)) finish();
  });
}

export async function pollProvisionRequest(
  draftId: string,
  request: DraftProvisionRequest,
  dispatch: (request: DraftProvisionRequest) => Promise<EnvironmentProvisionResult | null>,
): Promise<EnvironmentProvisionResult | { kind: "cancelled" } | { kind: "unreachable" }> {
  let result: EnvironmentProvisionResult | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!isProvisionRequestActive(draftId)) return { kind: "cancelled" };
    try {
      result = await dispatch(request);
    } catch {
      result = null;
    }
    if (!isProvisionRequestActive(draftId)) return { kind: "cancelled" };
    if (result?.kind === "ready" || result?.kind === "refused") return result;
    if (attempt < 59) await waitForProvisionRetry(draftId);
  }
  return result ?? { kind: "unreachable" };
}
