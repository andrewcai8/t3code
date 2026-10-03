import { createProvisionedSandboxLeaseStore } from "@t3tools/client-runtime/cloud";

import { localProvisionStorage } from "./provisionStorage";

export const provisionedSandboxLeases = createProvisionedSandboxLeaseStore(localProvisionStorage);

export const {
  transfer: transferProvisionedSandboxLease,
  leaseFor: provisionedSandboxFor,
  leaseOwnedByEnvironment: provisionedSandboxOwnedByEnvironment,
  forget: forgetProvisionedSandbox,
} = provisionedSandboxLeases;
