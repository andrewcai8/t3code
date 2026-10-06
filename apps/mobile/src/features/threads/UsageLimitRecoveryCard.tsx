import { useAtomValue } from "@effect/atom-react";
import { describeAccountSwitch } from "@t3tools/client-runtime/cloud";
import { connectionBox } from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { environmentCatalog } from "../../connection/catalog";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function UsageLimitRecoveryCard({
  thread,
  environmentId,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
}) {
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const switchAccount = useAtomCommand(serverEnvironment.switchProvisionedAccount, {
    reportFailure: false,
  });
  // Only a cloud box's host can move its chat onto another account.
  const boxManagerId = useAtomValue(
    environmentCatalog.catalogValueAtom,
    useCallback(
      (catalog: EnvironmentCatalogState) => {
        const target = catalog.entries.get(environmentId)?.target;
        return target === undefined ? null : (connectionBox(target)?.managerId ?? null);
      },
      [environmentId],
    ),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchedNotice, setSwitchedNotice] = useState<string | null>(null);
  const resetAt = thread.runtime?.usageLimitResetAt ?? null;
  const canSchedule =
    resetAt !== null &&
    Date.parse(resetAt) > Date.parse(thread.latestRun?.completedAt ?? thread.updatedAt);
  const runId = thread.latestRun?.runId;
  const recovery = thread.limitRecovery;
  const scheduled =
    recovery?.runId === runId && recovery?.resetAt === resetAt && recovery?.autoResume;
  if (
    thread.runtime?.status !== "failed" ||
    thread.runtime.lastErrorClass !== "usage_limit" ||
    !runId
  )
    return null;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    thread.snoozedUntil !== null &&
    Date.parse(thread.snoozedUntil) === Date.parse(resetAt);
  async function toggle(action: "resume" | "snooze") {
    if (!resetAt || !runId || !canSchedule) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      setError("The reset time has passed. Retry the thread manually.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await updateMetadata({
        environmentId,
        input: {
          threadId: thread.id,
          limitRecovery: {
            runId,
            resetAt,
            ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
          },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    } finally {
      setPending(false);
    }
  }
  async function moveToAnotherAccount() {
    if (boxManagerId === null) return;
    setSwitching(true);
    setError(null);
    setSwitchedNotice(null);
    try {
      const result = await switchAccount({
        environmentId: boxManagerId,
        input: { environmentId, threadId: thread.id },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      const { switched, title, description } = describeAccountSwitch(result.value);
      if (switched) setSwitchedNotice(`${title}. ${description}`);
      else setError(description);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not switch accounts.");
    } finally {
      setSwitching(false);
    }
  }
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-background p-3">
      <Text className="text-sm text-warning-foreground">
        {resetAt
          ? `Usage limit resets ${DateTime.toDateUtc(DateTime.makeUnsafe(resetAt)).toLocaleString()}.`
          : "The provider did not report a reset time. Retry manually when your limit is available."}
      </Text>
      {canSchedule || boxManagerId !== null ? (
        <View className="flex-row flex-wrap gap-2">
          {canSchedule ? (
            <>
              <Pressable
                accessibilityRole="button"
                disabled={pending || switching}
                onPress={() => void toggle("resume")}
                className="self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
              >
                <Text className="text-sm text-foreground">
                  {scheduled ? "Cancel auto-resume" : "Resume at reset"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={pending || switching || (!snoozed && Date.parse(resetAt!) <= Date.now())}
                onPress={() => void toggle("snooze")}
                className="self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
              >
                <Text className="text-sm text-foreground">
                  {snoozed ? "Wake now" : "Snooze until reset"}
                </Text>
              </Pressable>
            </>
          ) : null}
          {boxManagerId !== null ? (
            <Pressable
              accessibilityRole="button"
              disabled={pending || switching}
              onPress={() => void moveToAnotherAccount()}
              className="self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
            >
              <Text className="text-sm text-foreground">
                {switching ? "Switching..." : "Switch account"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {switchedNotice ? <Text className="text-sm text-foreground">{switchedNotice}</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
