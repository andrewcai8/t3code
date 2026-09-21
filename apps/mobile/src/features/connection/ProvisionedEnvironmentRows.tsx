import { useAtomValue } from "@effect/atom-react";
import {
  isOffDeviceReachablePairingUrl,
  joinProvisionedEnvironment,
  provisionedGatewayPairingUrl,
} from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { DiscoveredProvisionedEnvironment, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { connectPairing } from "../../connection/onboarding";
import { cn } from "../../lib/cn";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { NewCloudMachineSheet } from "./NewCloudMachineSheet";
import {
  presentProvisionedEnvironment,
  provisionedEnvironmentRows,
  isProvisionedEnvironmentConnected,
  type ProvisionedEnvironmentRow,
  type ProvisionedJoinState,
} from "./provisionedEnvironmentRowModel";

const IDLE: ProvisionedJoinState = { kind: "idle" };

/**
 * "Cloud machines" section: every machine a connected manager has provisioned, with a Join
 * that pairs this device to the machine's own server and a Leave that forgets it again.
 * Renders nothing for an environment that is not a manager.
 */
export function ProvisionedEnvironmentRows(props: {
  readonly managerId: EnvironmentId;
  readonly managerLabel: string;
  readonly connectedEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  /** Forget a joined machine on this device. The callback owns the confirm. */
  readonly onLeave: (environmentId: EnvironmentId) => void;
}) {
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(props.managerId))?.environmentControl === true;
  const query = useEnvironmentQuery(
    supported
      ? serverEnvironment.provisionedEnvironments({ environmentId: props.managerId, input: {} })
      : null,
  );
  const attach = useAtomCommand(serverEnvironment.attachProvisionedEnvironment, {
    reportFailure: false,
  });
  const resume = useAtomCommand(serverEnvironment.resumeProvisionedEnvironment, {
    reportFailure: false,
  });
  const resumeUnclaimed = useAtomCommand(serverEnvironment.resumeUnclaimedProvisionedEnvironment, {
    reportFailure: false,
  });
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  const [joinStates, setJoinStates] = useState<Readonly<Record<string, ProvisionedJoinState>>>({});
  const [creating, setCreating] = useState(false);
  const rows = useMemo(
    () => provisionedEnvironmentRows(query.data ?? [], props.connectedEnvironments),
    [query.data, props.connectedEnvironments],
  );
  const { connectedEnvironments, managerId } = props;
  const manager = connectedEnvironments.find((entry) => entry.environmentId === managerId);
  const join = useCallback(
    async (environment: DiscoveredProvisionedEnvironment) => {
      const setJoinState = (state: ProvisionedJoinState) =>
        setJoinStates((current) => ({ ...current, [environment.requestId]: state }));
      setJoinState({ kind: "joining" });
      try {
        const outcome = await joinProvisionedEnvironment(environment, {
          isConnected: (id) => isProvisionedEnvironmentConnected(id, connectedEnvironments),
          attach: async () => {
            if (environment.lifecycle === "paused") {
              const resumed =
                environment.threadId === null
                  ? await resumeUnclaimed({
                      environmentId: managerId,
                      input: {
                        leaseId: environment.leaseId,
                        sandboxId: environment.sandboxId,
                        environmentId: environment.environmentId,
                      },
                    })
                  : await resume({
                      environmentId: managerId,
                      input: {
                        leaseId: environment.leaseId,
                        sandboxId: environment.sandboxId,
                        environmentId: environment.environmentId,
                        threadId: environment.threadId,
                      },
                    });
              if (AsyncResult.isFailure(resumed) || resumed.value.kind !== "resumed") {
                return {
                  kind: "refused" as const,
                  message: AsyncResult.isFailure(resumed)
                    ? "The manager could not resume this environment. Try again."
                    : resumed.value.kind === "refused"
                      ? resumed.value.message
                      : "The manager could not resume this environment. Try again.",
                };
              }
            }
            const result = await attach({
              environmentId: managerId,
              input: { requestId: environment.requestId },
            });
            if (AsyncResult.isFailure(result))
              throw new Error("The manager could not issue a connection. Try again.");
            return result.value;
          },
          pair: async (pairingUrl) => {
            const result = await pair({
              pairingUrl,
              expectedEnvironmentId: environment.environmentId,
            });
            if (AsyncResult.isFailure(result)) {
              const error = Cause.squash(result.cause);
              throw error instanceof Error
                ? error
                : new Error("The machine could not be connected. Try again.");
            }
            return result.value;
          },
          ...(manager?.displayUrl
            ? {
                rewritePairingUrl: (pairingUrl: string, lease: { readonly leaseId: string }) =>
                  provisionedGatewayPairingUrl(manager.displayUrl, lease.leaseId, pairingUrl),
              }
            : {}),
          canReach: isOffDeviceReachablePairingUrl,
        });
        setJoinState(
          outcome.kind === "joined"
            ? IDLE
            : outcome.kind === "unreachable"
              ? { kind: "unreachable" }
              : { kind: "failed", message: outcome.message },
        );
      } catch (error) {
        setJoinState({
          kind: "failed",
          message: error instanceof Error ? error.message : "The machine could not be joined.",
        });
      }
    },
    [attach, connectedEnvironments, manager, managerId, pair, resume, resumeUnclaimed],
  );

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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New cloud machine"
            onPress={() => setCreating(true)}
            className="h-9 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70"
          >
            <SymbolView
              name="plus"
              size={14}
              tintColorClassName={"accent-icon"}
              type="monochrome"
            />
          </Pressable>
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
            No cloud machines yet. Start one and it keeps running after you close the app.
          </Text>
        </View>
      ) : (
        <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
          {rows.map((row, index) => (
            <ProvisionedEnvironmentRowView
              key={row.environment.requestId}
              row={row}
              join={joinStates[row.environment.requestId] ?? IDLE}
              managerLabel={props.managerLabel}
              borderTop={index !== 0}
              onJoin={() => void join(row.environment)}
              onLeave={() => {
                if (row.joined !== null) props.onLeave(row.joined.environmentId);
              }}
            />
          ))}
        </View>
      )}
      {creating ? (
        <NewCloudMachineSheet
          managerId={props.managerId}
          managerLabel={props.managerLabel}
          connectedEnvironments={props.connectedEnvironments}
          onClose={() => {
            setCreating(false);
            query.refresh();
          }}
        />
      ) : null}
    </View>
  );
}

function ProvisionedEnvironmentRowView(props: {
  readonly row: ProvisionedEnvironmentRow;
  readonly join: ProvisionedJoinState;
  readonly managerLabel: string;
  readonly borderTop: boolean;
  readonly onJoin: () => void;
  readonly onLeave: () => void;
}) {
  const { environment, joined } = props.row;
  // The machine's thread is only readable once this device has joined it.
  const thread = useThreadShell(
    joined !== null && environment.threadId !== null
      ? scopeThreadRef(environment.environmentId, environment.threadId)
      : null,
  );
  const presentation = presentProvisionedEnvironment({
    row: props.row,
    join: props.join,
    managerLabel: props.managerLabel,
    threadTitle: thread?.title ?? null,
  });
  const connectionState = joined?.isEnabled ? joined.connectionState : "available";
  return (
    <View
      collapsable={false}
      className={cn(
        "flex-row items-center gap-3 bg-card px-4 py-3.5",
        props.borderTop && "border-t border-border",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="min-w-0 flex-row items-center gap-2">
          <ConnectionStatusDot
            state={connectionState}
            pulse={connectionState === "connecting" || connectionState === "reconnecting"}
            size={7}
          />
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
      {presentation.action === null ? (
        <ActivityIndicator colorClassName={"accent-icon"} size="small" />
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={presentation.action === "join" ? props.onJoin : props.onLeave}
          className="rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
        >
          <Text className="text-xs font-t3-bold text-foreground">
            {presentation.action === "join" ? "Join" : "Leave"}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
