import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { offeredProvisionProviders } from "@t3tools/client-runtime/cloud";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { DiscoveredProvisionedEnvironment, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { cn } from "../../lib/cn";
import { useThreadShell } from "../../state/entities";
import { provisionedSandboxLeases } from "../../state/provision-stores";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  presentProvisionedEnvironment,
  type ProvisionedRowAction,
} from "./provisionedEnvironmentRowModel";

const IDLE: ProvisionedRowAction = { kind: "idle" };

/**
 * "Cloud machines" section: every machine a connected manager runs for a chat. A machine belongs
 * to its chat, so it is opened through that chat; here it can be woken, kept from automatic
 * cleanup, deleted or restored once deleted, and the "+" starts a new cloud chat. Renders nothing for an environment
 * that is not a manager.
 */
export function ProvisionedEnvironmentRows(props: {
  readonly managerId: EnvironmentId;
  readonly managerLabel: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.managerId));
  const supported = config?.environmentControl === true;
  const canCreate = offeredProvisionProviders(config).length > 0;
  const query = useEnvironmentQuery(
    supported
      ? serverEnvironment.provisionedEnvironments({ environmentId: props.managerId, input: {} })
      : null,
  );
  const resume = useAtomCommand(serverEnvironment.resumeProvisionedEnvironment, {
    reportFailure: false,
  });
  const dispose = useAtomCommand(serverEnvironment.disposeProvisionedEnvironment, {
    reportFailure: false,
  });
  const keep = useAtomCommand(serverEnvironment.keepProvisionedEnvironment, {
    reportFailure: false,
  });
  const restore = useAtomCommand(serverEnvironment.restoreProvisionedEnvironment, {
    reportFailure: false,
  });
  const navigation = useNavigation();
  const [actions, setActions] = useState<Readonly<Record<string, ProvisionedRowAction>>>({});
  const rows = query.data ?? [];
  const { managerId } = props;

  async function act(
    environment: DiscoveredProvisionedEnvironment,
    label: string,
    run: () => Promise<string | null>,
  ) {
    const setAction = (action: ProvisionedRowAction) =>
      setActions((current) => ({ ...current, [environment.requestId]: action }));
    setAction({ kind: "working", label });
    const failure = await run();
    setAction(failure === null ? IDLE : { kind: "failed", message: failure });
    query.refresh();
  }
  const resumeEnvironment = (environment: DiscoveredProvisionedEnvironment) =>
    act(environment, "Resuming…", async () => {
      const result = await resume({
        environmentId: managerId,
        input: { environmentId: environment.environmentId },
      });
      if (result._tag === "Failure") return "The host could not resume this machine. Try again.";
      return result.value.kind === "resumed" ? null : result.value.message;
    });
  const keepEnvironment = (environment: DiscoveredProvisionedEnvironment, kept: boolean) =>
    act(environment, kept ? "Keeping…" : "Allowing cleanup…", async () => {
      const result = await keep({
        environmentId: managerId,
        input: { requestId: environment.requestId, keep: kept },
      });
      if (result._tag === "Failure") return "The host could not update this machine. Try again.";
      return result.value.kind === "updated" ? null : result.value.message;
    });
  const deleteEnvironment = (environment: DiscoveredProvisionedEnvironment, title: string) =>
    Alert.alert(
      "Delete this cloud machine?",
      `This stops the machine for "${title}" and ends any running work. A chat's machine can be restored here for 30 days. The chat's history stays.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            void act(environment, "Deleting…", async () => {
              const result = await dispose({
                environmentId: managerId,
                input: { requestId: environment.requestId },
              });
              if (result._tag === "Failure" || result.value.kind !== "disposed")
                return "The host could not delete this machine. Try again.";
              // A machine that can be restored keeps its chat's lease, so a restore brings both back.
              if (environment.threadId !== null && result.value.restorableUntil === undefined)
                provisionedSandboxLeases.forget(
                  scopeThreadRef(environment.environmentId, environment.threadId),
                );
              return null;
            }),
        },
      ],
    );
  const restoreEnvironment = (environment: DiscoveredProvisionedEnvironment) =>
    act(environment, "Restoring…", async () => {
      const result = await restore({
        environmentId: managerId,
        input: { leaseId: environment.leaseId },
      });
      if (result._tag === "Failure") return "The host could not restore this machine. Try again.";
      return result.value.kind === "restored" ? null : result.value.message;
    });

  if (!supported) return null;
  return (
    <View collapsable={false} className="mt-5 gap-3">
      <View className="flex-row items-center justify-between gap-3 px-1">
        <Text
          className="min-w-0 flex-1 text-sm font-t3-bold uppercase text-foreground-muted"
          numberOfLines={1}
        >
          Cloud machines · {props.managerLabel}
        </Text>
        <View className="flex-row items-center gap-2">
          {canCreate ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New cloud chat"
              onPress={() =>
                navigation.navigate("NewTaskSheet", {
                  screen: "NewTaskCloudMachine",
                  params: { environmentId: String(props.managerId) },
                })
              }
              className="h-9 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70"
            >
              <SymbolView
                name="plus"
                size={14}
                tintColorClassName={"accent-icon"}
                type="monochrome"
              />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh cloud machines"
            disabled={query.isPending}
            onPress={query.refresh}
            className="h-9 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70 disabled:opacity-50"
          >
            {query.isPending ? (
              <ActivityIndicator colorClassName={"accent-icon"} size="small" />
            ) : (
              <SymbolView
                name="arrow.clockwise"
                size={14}
                tintColorClassName={"accent-icon"}
                type="monochrome"
              />
            )}
          </Pressable>
        </View>
      </View>
      {query.error ? (
        <View collapsable={false} className="rounded-[24px] bg-card p-5">
          <Text className="text-sm text-foreground-muted">
            Cloud machines could not be loaded. Refresh to try again.
          </Text>
        </View>
      ) : rows.length === 0 ? (
        <View collapsable={false} className="rounded-[24px] bg-card p-5">
          <Text className="text-sm text-foreground-muted">
            No cloud machines yet. Start a cloud chat and its machine keeps running after you close
            the app.
          </Text>
        </View>
      ) : (
        <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
          {rows.map((environment, index) => (
            <ProvisionedEnvironmentRowView
              key={environment.requestId}
              environment={environment}
              action={actions[environment.requestId] ?? IDLE}
              borderTop={index !== 0}
              onResume={() => void resumeEnvironment(environment)}
              onKeep={(kept) => void keepEnvironment(environment, kept)}
              onDelete={(title) => deleteEnvironment(environment, title)}
              onRestore={() => void restoreEnvironment(environment)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function ProvisionedEnvironmentRowView(props: {
  readonly environment: DiscoveredProvisionedEnvironment;
  readonly action: ProvisionedRowAction;
  readonly borderTop: boolean;
  readonly onResume: () => void;
  readonly onKeep: (keep: boolean) => void;
  readonly onDelete: (title: string) => void;
  readonly onRestore: () => void;
}) {
  const { environment } = props;
  const threadRef =
    environment.threadId === null
      ? null
      : scopeThreadRef(environment.environmentId, environment.threadId);
  // Only a chat this device has is readable here, and only that one can be opened.
  const thread = useThreadShell(threadRef);
  const navigation = useNavigation();
  // Read once per row: the countdown is coarse, and the list refreshes after every action.
  const [now] = useState(Date.now);
  const presentation = presentProvisionedEnvironment({
    environment,
    threadTitle: thread?.title ?? null,
    action: props.action,
    now,
  });
  const working = props.action.kind === "working";
  const buttons = [
    ...(environment.lifecycle === "paused" ? [{ label: "Resume", onPress: props.onResume }] : []),
    ...(presentation.cleanupAction === null
      ? []
      : [
          {
            label: presentation.cleanupAction === "keep" ? "Keep" : "Allow cleanup",
            onPress: () => props.onKeep(presentation.cleanupAction === "keep"),
          },
        ]),
    ...(thread !== null && threadRef !== null
      ? [
          {
            label: "Open chat",
            onPress: () =>
              navigation.navigate("Thread", {
                environmentId: String(threadRef.environmentId),
                threadId: String(threadRef.threadId),
              }),
          },
        ]
      : []),
    ...(presentation.restorable ? [{ label: "Restore", onPress: props.onRestore }] : []),
    ...(environment.lifecycle === "disposed"
      ? []
      : [{ label: "Delete", onPress: () => props.onDelete(presentation.title) }]),
  ];
  return (
    <View
      collapsable={false}
      className={cn("gap-2 bg-card px-4 py-3.5", props.borderTop && "border-t border-border")}
    >
      <View className="min-w-0 gap-0.5">
        <View className="min-w-0 flex-row items-center gap-2">
          <EnvironmentMachineSymbol
            kind="cloud"
            size={14}
            tintColorClassName="accent-foreground-muted"
          />
          <Text
            className="min-w-0 flex-shrink text-base font-t3-bold leading-snug text-foreground"
            numberOfLines={1}
          >
            {presentation.title}
          </Text>
        </View>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {presentation.detail}
        </Text>
        <Text
          className={cn(
            "text-xs",
            presentation.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted",
          )}
        >
          {presentation.status}
        </Text>
      </View>
      {working ? (
        <ActivityIndicator colorClassName={"accent-icon"} size="small" />
      ) : (
        <View className="flex-row gap-2">
          {buttons.map((button) => (
            <Pressable
              key={button.label}
              accessibilityRole="button"
              onPress={button.onPress}
              className="rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
            >
              <Text className="text-xs font-t3-bold text-foreground">{button.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
