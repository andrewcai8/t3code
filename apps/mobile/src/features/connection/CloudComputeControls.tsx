import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

export function CloudComputeControls({
  managerId,
  managerLabel,
  onStarted,
}: {
  managerId: EnvironmentId;
  managerLabel: string;
  onStarted: (id: EnvironmentId) => boolean;
}) {
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(managerId))?.environmentControl === true;
  const query = useEnvironmentQuery(
    supported
      ? serverEnvironment.managedEnvironments({ environmentId: managerId, input: {} })
      : null,
  );
  const start = useAtomCommand(serverEnvironment.startManagedEnvironment, { reportFailure: false });
  const stop = useAtomCommand(serverEnvironment.stopManagedEnvironment, { reportFailure: false });
  const [pending, setPending] = useState<EnvironmentId | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function act(environmentId: EnvironmentId, action: "start" | "stop") {
    setPending(environmentId);
    setMessage(null);
    try {
      const result = await (action === "start" ? start : stop)({
        environmentId: managerId,
        input: { environmentId },
      });
      if (AsyncResult.isFailure(result))
        setMessage("Compute command failed. Refresh to check the provider state.");
      else if (result.value.kind === "refused") setMessage(result.value.message);
      else if (action === "start" && !onStarted(environmentId))
        setMessage(
          "Started. Choose this environment in T3 Connect or pair with it to connect this device.",
        );
    } finally {
      setPending(null);
    }
  }
  if (!query.error && !query.data?.length) return null;
  return (
    <View className="mt-4 gap-3 rounded-[24px] bg-card p-4">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-xs text-foreground-muted">
          Cloud compute managed by {managerLabel}
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={query.isPending || pending !== null}
          onPress={query.refresh}
          className="p-2"
        >
          <Text className="text-sm text-foreground">Refresh</Text>
        </Pressable>
      </View>
      {query.error ? (
        <Text className="text-xs text-foreground-muted">
          Cloud controls unavailable. The manager must be connected and configured.
        </Text>
      ) : null}
      {query.data?.map((environment) => (
        <View
          key={environment.environmentId}
          className="flex-row items-center justify-between gap-3"
        >
          <View className="flex-1">
            <Text className="text-sm text-foreground">{environment.label}</Text>
            <Text className="text-xs text-foreground-muted">
              Compute:{" "}
              {environment.state.kind === "unavailable"
                ? environment.state.message
                : environment.state.kind}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={pending !== null || environment.state.kind === "unavailable"}
            onPress={() =>
              void act(
                environment.environmentId,
                environment.state.kind === "running" ? "stop" : "start",
              )
            }
            className="rounded-lg bg-subtle px-4 py-3"
          >
            <Text className="text-sm text-foreground">
              {pending === environment.environmentId
                ? "Working…"
                : environment.state.kind === "running"
                  ? "Stop"
                  : "Start"}
            </Text>
          </Pressable>
        </View>
      ))}
      {message ? (
        <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
          {message}
        </Text>
      ) : null}
    </View>
  );
}
