import { ThreadDetailsSelectControl } from "./chat/ThreadDetailsControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, ScaleIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";
import { cn } from "../lib/utils";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";

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
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  // Absent where an environment cannot be created, which is any install
  // without a configured cloud manager.
  onCreateCloudEnvironment?: ((provider: CloudEnvironmentProvider) => void) | undefined;
  onCreateNamespaceEnvironment?: ((provider: CloudEnvironmentProvider) => void) | undefined;
  creatingCloudEnvironment?: boolean;
  pendingCloudProvider?: CloudEnvironmentProvider | null;
  displayMode?: "toolbar" | "panel";
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
  displayMode = "toolbar",
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
    const lockedRow = (
      <span
        className={cn(
          "inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
        data-composer-context-control
      >
        <EnvironmentMachineIcon
          kind={activeEnvironment?.machine ?? "server"}
          className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"}
        />
        <ComposerContextLabel displayMode={displayMode}>
          {activeEnvironment?.label ?? "Run on"}
        </ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
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
            <ThreadDetailsSelectControl
              panel={displayMode === "panel"}
              className="min-w-0 max-w-full"
              aria-label="Run on"
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          {autoEnvironmentLabel ? (
            <ScaleIcon
              className={
                displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
              }
              aria-hidden="true"
            />
          ) : (
            <EnvironmentMachineIcon
              kind={activeEnvironment?.machine ?? "server"}
              className={
                displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"
              }
            />
          )}
          <ComposerContextLabel displayMode={displayMode}>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>{autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}</TooltipPopup>
      </Tooltip>
      <SelectPopup
        alignItemWithTrigger={false}
        {...(displayMode === "toolbar" ? composerFloatingLayerProps : {})}
        {...(displayMode === "panel"
          ? {
              className: "w-(--anchor-width)",
            }
          : {})}
      >
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
