import {
  cloneRepository,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

/**
 * The choices a phone has to make before a manager can start a cloud machine: which repository
 * the machine clones, which sandbox provider runs it, and which provider account its agent
 * signs in as. Kept separate from the sheet so the narrowing rules are testable.
 */

export type CloudMachineProvider = "e2b" | "namespace";

export const CLOUD_MACHINE_PROVIDER_LABELS: Readonly<Record<CloudMachineProvider, string>> = {
  e2b: "E2B",
  namespace: "Namespace Mac",
};

export interface CloudMachineRepositoryOption {
  /** `owner/name`, which is also what the provision input carries. */
  readonly repository: string;
  /** Every project on this device that clones to the same repository, for the subtitle. */
  readonly projectTitles: ReadonlyArray<string>;
}

interface RepositoryProject {
  readonly title: string;
  readonly repositoryIdentity?: Parameters<typeof cloneRepository>[0];
}

/**
 * One row per distinct repository across the manager's projects. A machine clones a repository,
 * not a checkout, so two projects on the same repository are one choice; their titles ride along
 * so the row still reads like something the person recognizes. Projects with no git identity
 * cannot be cloned and are dropped.
 */
export function cloudMachineRepositoryOptions(
  projects: ReadonlyArray<RepositoryProject>,
): ReadonlyArray<CloudMachineRepositoryOption> {
  const byRepository = new Map<string, Array<string>>();
  for (const project of projects) {
    const repository = cloneRepository(project.repositoryIdentity);
    if (!repository) continue;
    const titles = byRepository.get(repository);
    if (titles) {
      if (!titles.includes(project.title)) titles.push(project.title);
      continue;
    }
    byRepository.set(repository, [project.title]);
  }
  return [...byRepository.entries()]
    .map(([repository, projectTitles]) => ({ repository, projectTitles }))
    .sort((left, right) => left.repository.localeCompare(right.repository));
}

export interface CloudMachineAccountOption {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly label: string;
  /**
   * The tightest window the manager last saw on this account, or null when the account cannot
   * report usage at all. An account this device is about to hand a machine to is worth choosing
   * by headroom: a guest signed in as an exhausted account boots fine and then cannot answer.
   */
  readonly usedPercent: number | null;
}

function tightestWindow(provider: ServerProvider): number | null {
  const limits = provider.usageLimits;
  if (!limits || limits.unavailable) return null;
  const used = limits.windows.map((window) => window.usedPercent);
  return used.length === 0 ? null : Math.max(...used);
}

/**
 * The accounts a machine can run its agent as. The guest signs in as the same account this
 * manager holds, so one that cannot run here cannot run there either. `warning` still can —
 * it covers things like an available CLI update, not a broken login.
 */
export function cloudMachineAccountOptions(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<CloudMachineAccountOption> {
  return providers
    .filter((provider) => provider.status === "ready" || provider.status === "warning")
    .map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      label: provider.displayName ?? provider.instanceId,
      usedPercent: tightestWindow(provider),
    }));
}

/**
 * Which account a fresh sheet starts on: the one with the most headroom. Order in settings says
 * nothing about which account can still do work, and starting on an exhausted one wastes the
 * minute a machine takes to build. Accounts that cannot report usage are a fallback, not a
 * preference, since nothing is known about them.
 */
export function defaultCloudMachineAccount(
  options: ReadonlyArray<CloudMachineAccountOption>,
): CloudMachineAccountOption | null {
  const measured = options.filter((option) => option.usedPercent !== null);
  if (measured.length === 0) return options[0] ?? null;
  return measured.reduce((best, option) =>
    (option.usedPercent ?? 100) < (best.usedPercent ?? 100) ? option : best,
  );
}

/** The usage line under an account row, or null when the account reports none. */
export function cloudMachineAccountDetail(option: CloudMachineAccountOption): string | null {
  return option.usedPercent === null ? null : `${Math.round(option.usedPercent)}% used`;
}

/**
 * The repository a fresh sheet starts on. One repository is not a choice, and making the person
 * tap it only to enable the button is friction; more than one has no defensible default.
 */
export function defaultCloudMachineRepository(
  options: ReadonlyArray<CloudMachineRepositoryOption>,
): string | null {
  return options.length === 1 ? (options[0]?.repository ?? null) : null;
}

export interface CloudMachineSelection {
  readonly repository: string | null;
  /** Null when the manager can provision no cloud platform. */
  readonly provider: CloudMachineProvider | null;
  readonly account: CloudMachineAccountOption | null;
}

/**
 * Why the Create button is disabled, or null when it is not. A repository is required: an empty
 * machine has nothing to work on, and the phone has no way to put a checkout on it afterwards.
 */
export function cloudMachineBlockReason(selection: CloudMachineSelection): string | null {
  if (selection.provider === null) return "This manager has no cloud platform set up.";
  if (selection.account === null) return "Connect a provider account first.";
  if (selection.repository === null) return "Choose a repository to clone.";
  return null;
}
