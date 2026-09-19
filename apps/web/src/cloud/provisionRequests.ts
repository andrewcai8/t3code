import { createProvisionRequestStore } from "@t3tools/client-runtime/cloud";

import { localProvisionStorage } from "./provisionStorage";
import { randomUUID } from "../lib/utils";

export const provisionRequests = createProvisionRequestStore({
  storage: localProvisionStorage,
  randomUUID,
  schedule: (callback, delayMs) => {
    const timer = globalThis.setTimeout(callback, delayMs);
    return () => globalThis.clearTimeout(timer);
  },
});

export const {
  reserve: reserveProvisionRequest,
  forget: forgetProvisionRequest,
  isActive: isProvisionRequestActive,
  cancel: cancelProvisionRequest,
  subscribeCancellations: subscribeProvisionCancellations,
  drainCancellations: drainProvisionCancellations,
} = provisionRequests;
