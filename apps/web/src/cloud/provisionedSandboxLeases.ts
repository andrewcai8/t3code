import { createProvisionedSandboxLeaseStore } from "@t3tools/client-runtime/cloud";

import { localProvisionStorage } from "./provisionStorage";

export const provisionedSandboxLeases = createProvisionedSandboxLeaseStore(localProvisionStorage);

export const {
  remember: rememberProvisionedSandbox,
  transfer: transferProvisionedSandboxLease,
  leaseFor: provisionedSandboxFor,
  leaseForEnvironment: provisionedSandboxForEnvironment,
  forget: forgetProvisionedSandbox,
} = provisionedSandboxLeases;
