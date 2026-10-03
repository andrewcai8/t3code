import type { EnvironmentId, RepositoryIdentity, VcsRef } from "@t3tools/contracts";
import { ChevronDownIcon, CloudIcon, GitBranchIcon } from "lucide-react";
import { type Ref, useDeferredValue, useImperativeHandle, useMemo, useState } from "react";

import { cn } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { BranchPicker, BranchPickerRefItem } from "./BranchPicker";
import type { BranchToolbarBranchSelectorHandle } from "./BranchToolbarBranchSelector";
import { ComposerControl } from "./chat/ComposerControl";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { ComboboxTrigger } from "./ui/combobox";
import { MenuRadioItem } from "./ui/menu";
import { MiddleTruncate } from "./ui/middle-truncate";
import { SelectItem } from "./ui/select";

export type CloudRunOnProvider = "e2b" | "namespace";

/** The branch a pending cloud machine starts from. Nothing is checked out here. */
export interface CloudBaseBranch {
  /** null is the repository's default branch. */
  readonly branch: string | null;
  /** null once the choice is fixed. */
  readonly onChange: ((branch: string) => void) | null;
}

/** The Run-on picker's cloud entries; absent where a draft cannot start a cloud machine. */
export interface CloudRunOn {
  readonly providers: ReadonlyArray<CloudRunOnProvider>;
  readonly onSelect: (provider: CloudRunOnProvider) => void;
  /** A cloud machine is being set up for the draft. */
  readonly creating: boolean;
  /** The cloud kind the draft starts on its first send. */
  readonly pending: CloudRunOnProvider | null;
  /** The branch the cloud machine starts from; see `BranchToolbarBranchSelector`. */
  readonly base: CloudBaseBranch | undefined;
}

// A sentinel rather than an environment id: the machine this names does not exist yet, which
// is the whole point of choosing it.
const OPTIONS = {
  e2b: { value: "create-cloud-environment", label: "E2B" },
  namespace: { value: "create-namespace-environment", label: "Namespace Mac" },
} satisfies Record<CloudRunOnProvider, { value: string; label: string }>;

/**
 * Whether the composer should offer a choice of machine.
 *
 * More than one machine is the obvious reason. Being able to create one is the other, and it is
 * the case that matters most: an install with a single machine would otherwise hide the control
 * that adds a second, so the first cloud machine could never be created from the place machines
 * are chosen.
 */
export function shouldOfferEnvironmentChoice(input: {
  environmentCount: number;
  canChangeEnvironment: boolean;
  canCreateEnvironment: boolean;
}): boolean {
  if (!input.canChangeEnvironment) return false;
  return input.environmentCount > 1 || input.canCreateEnvironment;
}

/** The Run-on value of the cloud kind the draft starts, if it starts one. */
export function cloudRunOnValue(cloudRunOn: CloudRunOn | undefined): string | null {
  return cloudRunOn?.pending ? OPTIONS[cloudRunOn.pending].value : null;
}

export function cloudRunOnLabel(cloudRunOn: CloudRunOn | undefined): string | null {
  return cloudRunOn?.pending ? OPTIONS[cloudRunOn.pending].label : null;
}

/** Takes a Run-on pick that names a cloud kind; false for any other value. */
export function selectCloudRunOn(cloudRunOn: CloudRunOn | undefined, value: unknown): boolean {
  const provider = cloudRunOn?.providers.find((candidate) => OPTIONS[candidate].value === value);
  if (!cloudRunOn || !provider) return false;
  cloudRunOn.onSelect(provider);
  return true;
}

export function cloudRunOnItems(
  cloudRunOn: CloudRunOn | undefined,
): Array<{ value: string; label: string }> {
  return cloudRunOn?.providers.map((provider) => OPTIONS[provider]) ?? [];
}

function entryLabel(cloudRunOn: CloudRunOn, provider: CloudRunOnProvider): string {
  const { label } = OPTIONS[provider];
  return cloudRunOn.creating && cloudRunOn.pending === provider ? `Preparing ${label}…` : label;
}

export function CloudRunOnSelectItems({ cloudRunOn }: { cloudRunOn: CloudRunOn | undefined }) {
  return cloudRunOn?.providers.map((provider) => (
    <SelectItem key={provider} value={OPTIONS[provider].value} disabled={cloudRunOn.creating}>
      <span className="inline-flex items-center gap-1.5">
        <CloudIcon className="size-3" aria-hidden="true" />
        {entryLabel(cloudRunOn, provider)}
      </span>
    </SelectItem>
  ));
}

export function CloudRunOnMenuItems({
  cloudRunOn,
  envLocked,
}: {
  cloudRunOn: CloudRunOn | undefined;
  envLocked: boolean;
}) {
  return cloudRunOn?.providers.map((provider) => (
    <MenuRadioItem
      key={provider}
      value={OPTIONS[provider].value}
      disabled={envLocked || cloudRunOn.creating}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <CloudIcon className="size-3" aria-hidden="true" />
        <span className="min-w-0 truncate">{entryLabel(cloudRunOn, provider)}</span>
      </span>
    </MenuRadioItem>
  ));
}

/**
 * The branches a cloud environment can start from: those on the remote it clones (see
 * `cloneRepository`), named as that remote names them. A local-only branch is left out, since the
 * cloud clones from GitHub.
 */
export function cloudBaseRefs(
  refs: ReadonlyArray<VcsRef>,
  identity: RepositoryIdentity | null | undefined,
): VcsRef[] {
  const remote = identity?.origin ? "origin" : identity?.locator.remoteName;
  const prefix = `${remote}/`;
  return refs.flatMap((ref) =>
    ref.isRemote && ref.remoteName === remote && ref.name.startsWith(prefix)
      ? [{ ...ref, name: ref.name.slice(prefix.length) }]
      : [],
  );
}

const CLOUD_BASE_REF_LIMIT = 100;

/**
 * The branch picker while a draft will start a cloud machine: it chooses the remote branch the
 * machine clones, in place of the checkout picker.
 */
export function CloudBaseBranchSelector({
  ref,
  className,
  environmentId,
  cwd,
  repositoryIdentity,
  base,
  onComposerFocusRequest,
}: {
  ref?: Ref<BranchToolbarBranchSelectorHandle>;
  className?: string;
  environmentId: EnvironmentId;
  cwd: string | null;
  repositoryIdentity: RepositoryIdentity | null | undefined;
  base: CloudBaseBranch;
  onComposerFocusRequest?: (() => void) | undefined;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query).trim();
  const listed = useEnvironmentQuery(
    cwd === null
      ? null
      : vcsEnvironment.listRefs({
          environmentId,
          input: {
            cwd,
            ...(deferredQuery.length > 0 ? { query: deferredQuery } : {}),
            // Every remote branch, including those a local branch shadows.
            refKind: "remote",
            includeMatchingRemoteRefs: true,
            limit: CLOUD_BASE_REF_LIMIT,
          },
        }),
  );
  const refs = useMemo(
    () => cloudBaseRefs(listed.data?.refs ?? [], repositoryIdentity),
    [listed.data, repositoryIdentity],
  );
  const refByName = useMemo(() => new Map(refs.map((ref) => [ref.name, ref] as const)), [refs]);
  const items = useMemo(() => refs.map((ref) => ref.name), [refs]);
  const normalizedQuery = deferredQuery.toLowerCase();
  const filteredItems = useMemo(
    () =>
      normalizedQuery.length === 0
        ? items
        : items.filter((name) => name.toLowerCase().includes(normalizedQuery)),
    [items, normalizedQuery],
  );
  const value = base.branch ?? refs.find((ref) => ref.isDefault)?.name ?? null;
  const loading = listed.isPending && listed.data === null;
  const disabled = base.onChange === null || loading;
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        if (disabled) return;
        setOpen(true);
      },
    }),
    [disabled],
  );
  const select = (name: string) => {
    base.onChange?.(name);
    onOpenChange(false);
    onComposerFocusRequest?.();
  };
  return (
    <BranchPicker
      items={items}
      filteredItems={filteredItems}
      open={open}
      onOpenChange={onOpenChange}
      onSelectItem={select}
      value={value}
      query={query}
      resultsQuery={deferredQuery}
      onQueryChange={setQuery}
      hasNextPage={false}
      isFetchingNextPage={false}
      onLoadNext={() => undefined}
      statusText={loading ? "Loading refs..." : null}
      renderItem={(name, index) => {
        const ref = refByName.get(name);
        // Every row is a remote branch named as the remote names it, so only the default badge
        // tells the rows apart.
        return ref ? (
          <BranchPickerRefItem
            branch={{ ...ref, isRemote: false, current: false, worktreePath: null }}
            projectCwd={cwd}
            index={index}
            value={name}
            onClick={() => select(name)}
          />
        ) : null;
      }}
      popupProps={{
        align: "end",
        side: "top",
        className: "flex w-80 flex-col",
        ...composerFloatingLayerProps,
      }}
    >
      <div className={cn("flex min-w-0 items-center gap-1", className)}>
        <ComboboxTrigger
          render={<ComposerControl size="xs" />}
          className="min-w-0 max-w-full active:scale-100"
          disabled={disabled}
        >
          <GitBranchIcon className="size-3 shrink-0 opacity-70" />
          <ComposerContextLabel>
            <MiddleTruncate value={value ?? "Default branch"} className="w-full" />
          </ComposerContextLabel>
          <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
        </ComboboxTrigger>
      </div>
    </BranchPicker>
  );
}
