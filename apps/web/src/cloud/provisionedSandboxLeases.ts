import { createProvisionedSandboxLeaseStore } from "@t3tools/client-runtime/cloud";

import { localProvisionStorage } from "./provisionStorage";

export const provisionedSandboxLeases = createProvisionedSandboxLeaseStore(localProvisionStorage);

export const {
  remember: rememberProvisionedSandbox,
  rememberForEnvironment: rememberProvisionedSandboxForEnvironment,
  transfer: transferProvisionedSandboxLease,
  leaseFor: provisionedSandboxFor,
  leaseForEnvironment: provisionedSandboxForEnvironment,
  leaseOwnedByEnvironment: provisionedSandboxOwnedByEnvironment,
  forget: forgetProvisionedSandbox,
} = provisionedSandboxLeases;
