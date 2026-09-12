/** Inputs needed to prepare a Namespace macOS Devbox for a T3 session. */
export interface NamespaceBootstrapInput {
  readonly workspaceDir: string;
  readonly t3Version: string;
  readonly port: number;
  readonly deviceToolchainInstallDir: string;
  readonly projectDir: string;
  readonly pairingLabel: string;
  readonly expoDeviceHubVersion: string;
  readonly agentDeviceVersion: string;
}

export interface NamespaceBootstrapPlan {
  readonly commands: readonly string[];
  readonly pairingCommand: string;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Build the deterministic command plan executed inside a Namespace Mac Devbox. */
export const makeNamespaceBootstrapPlan = (
  input: NamespaceBootstrapInput,
): NamespaceBootstrapPlan => {
  const workspace = shellQuote(input.workspaceDir);
  const project = shellQuote(input.projectDir);
  const tools = shellQuote(input.deviceToolchainInstallDir);
  const t3 = shellQuote(`t3@${input.t3Version}`);
  const t3Binary = shellQuote(`${input.workspaceDir}/node_modules/.bin/t3`);
  const hub = shellQuote(`expo-device-hub@${input.expoDeviceHubVersion}`);
  const agent = shellQuote(`agent-device@${input.agentDeviceVersion}`);
  const serve = `cd ${project} && ${t3Binary} serve --no-browser --host 0.0.0.0 --port ${input.port}`;
  const pairingCommand = `cd ${project} && ${t3Binary} pair --ttl 12h --label ${shellQuote(input.pairingLabel)}`;

  return {
    commands: [
      `mkdir -p ${workspace}`,
      `npm install --prefix ${workspace} --no-save ${t3}`,
      `npm install --prefix ${tools} --no-save ${hub} ${agent}`,
      serve,
    ],
    pairingCommand,
  };
};
