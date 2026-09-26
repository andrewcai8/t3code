import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, ScaleIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";

import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export const CREATE_CLOUD_VALUE = "create-cloud-environment";
export const CREATE_NAMESPACE_VALUE = "create-namespace-environment";

export type CloudEnvironmentProvider = "e2b" | "namespace";
export const CLOUD_ENVIRONMENT_OPTIONS = {
  e2b: { value: CREATE_CLOUD_VALUE, label: "E2B" },
  namespace: { value: CREATE_NAMESPACE_VALUE, label: "Namespace Mac" },
} satisfies Record<CloudEnvironmentProvider, { value: string; label: string }>;

interface BranchToolbarEnvironmentSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  // Absent when there is only one environment to show: the indicator still
  // renders (as a static label) so remote projects are always identifiable.
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  // Absent where an environment cannot be created, which is any install
  // without a configured cloud manager.
  onCreateCloudEnvironment?: ((provider: CloudEnvironmentProvider) => void) | undefined;
  onCreateNamespaceEnvironment?: ((provider: CloudEnvironmentProvider) => void) | undefined;
  creatingCloudEnvironment?: boolean;
  pendingCloudProvider?: CloudEnvironmentProvider | null;
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  environmentId,
  onCreateCloudEnvironment,
  onCreateNamespaceEnvironment,
  creatingCloudEnvironment,
  pendingCloudProvider,
  availableEnvironments,
  onEnvironmentChange,
}: BranchToolbarEnvironmentSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);

  const environmentItems = useMemo(
    () => [
      ...(onAutoEnvironment
        ? [{ value: "auto", label: autoEnvironmentLabel ?? "Auto balance" }]
        : []),
      ...availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: env.label,
      })),
      ...(onCreateCloudEnvironment ? [{ value: CREATE_CLOUD_VALUE, label: "E2B" }] : []),
      ...(onCreateNamespaceEnvironment
        ? [{ value: CREATE_NAMESPACE_VALUE, label: "Namespace Mac" }]
        : []),
    ],
    [
      availableEnvironments,
      autoEnvironmentLabel,
      onAutoEnvironment,
      onCreateCloudEnvironment,
      onCreateNamespaceEnvironment,
    ],
  );

  // The static label carries the xs control's height (h-7 sm:h-6) as well as
  // its padding: the composer context strip has no min-height of its own, and
  // the glass seam joining it to the composer assumes a fixed strip height, so
  // a shorter label would drag the seam out of line whenever this label is the
  // only thing in the strip.
  if (envLocked || onEnvironmentChange === undefined) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span />}
          className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
          data-composer-context-control
        >
          <EnvironmentMachineIcon
            kind={activeEnvironment?.machine ?? "server"}
            className="size-3 shrink-0"
          />
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              {activeEnvironment?.label ?? "Run on"}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup>{activeEnvironment?.label ?? "Run on"}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={
        pendingCloudProvider
          ? CLOUD_ENVIRONMENT_OPTIONS[pendingCloudProvider].value
          : autoEnvironmentLabel
            ? "auto"
            : environmentId
      }
      onValueChange={(value) => {
        // A sentinel rather than an environment id: the machine this names
        // does not exist yet, which is the whole point of choosing it.
        if (value === CREATE_CLOUD_VALUE) {
          onCreateCloudEnvironment?.("e2b");
          return;
        }
        if (value === CREATE_NAMESPACE_VALUE) {
          onCreateNamespaceEnvironment?.("namespace");
          return;
        }
        if (value === "auto") {
          onAutoEnvironment?.();
          return;
        }
        onEnvironmentChange(value as EnvironmentId);
      }}
      items={environmentItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              variant="ghost"
              size="xs"
              className="min-w-0 max-w-full"
              aria-label="Run on"
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          {autoEnvironmentLabel ? (
            <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <EnvironmentMachineIcon
              kind={activeEnvironment?.machine ?? "server"}
              className="size-3 shrink-0"
            />
          )}
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              <SelectValue />
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup>{autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}</TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {onAutoEnvironment && (
            <SelectItem
              value="auto"
              onClick={() => {
                if (autoEnvironmentLabel) onAutoEnvironment?.();
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <ScaleIcon className="size-3" aria-hidden="true" />
                {autoEnvironmentLabel ?? "Auto balance"}
              </span>
            </SelectItem>
          )}
          {availableEnvironments.map((env) => (
            <SelectItem key={env.environmentId} value={env.environmentId}>
              <span className="inline-flex items-center gap-1.5">
                <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                {env.label}
              </span>
            </SelectItem>
          ))}
          {onCreateCloudEnvironment ? (
            <SelectItem value={CREATE_CLOUD_VALUE} disabled={creatingCloudEnvironment === true}>
              <span className="inline-flex items-center gap-1.5">
                <CloudIcon className="size-3" aria-hidden="true" />
                {creatingCloudEnvironment && pendingCloudProvider === "e2b"
                  ? "Preparing E2B…"
                  : "E2B"}
              </span>
            </SelectItem>
          ) : null}
          {onCreateNamespaceEnvironment ? (
            <SelectItem value={CREATE_NAMESPACE_VALUE} disabled={creatingCloudEnvironment === true}>
              <span className="inline-flex items-center gap-1.5">
                <CloudIcon className="size-3" aria-hidden="true" />
                {creatingCloudEnvironment && pendingCloudProvider === "namespace"
                  ? "Preparing Namespace Mac…"
                  : "Namespace Mac"}
              </span>
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
