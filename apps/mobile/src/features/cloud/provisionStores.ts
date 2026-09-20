import {
  createProvisionRequestStore,
  createProvisionedSandboxLeaseStore,
} from "@t3tools/client-runtime/cloud";

import { uuidv4 } from "../../lib/uuid";
import { mobileProvisionStorage } from "./provisionStorage";

/**
 * This device's record of the cloud machines it started. Shared by every surface that can
 * provision one, so a machine created from the phone is the same record the disposal and
 * heartbeat paths read.
 */
export const provisionRequests = createProvisionRequestStore({
  storage: mobileProvisionStorage,
  randomUUID: uuidv4,
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
});

export const provisionedSandboxLeases = createProvisionedSandboxLeaseStore(mobileProvisionStorage);
