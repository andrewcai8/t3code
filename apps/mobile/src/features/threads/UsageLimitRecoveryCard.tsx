import { useAtomValue } from "@effect/atom-react";
import { describeAccountSwitch } from "@t3tools/client-runtime/cloud";
import { connectionBox } from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
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
  // Whether the reset already passed is state a timer flips at resetAt: the
  // compiler caches render output on its inputs, so reading the clock during
  // render would leave the snooze button enabled after the reset.
  const resetAtMs = resetAt === null ? null : Date.parse(resetAt);
  const [resetPassedFor, setResetPassedFor] = useState<number | null>(null);
  const resetPassed = resetAtMs !== null && resetPassedFor === resetAtMs;
  useEffect(() => {
    if (resetAtMs === null || Number.isNaN(resetAtMs)) return;
    const flip = () => setResetPassedFor(resetAtMs);
    const delay = resetAtMs - Date.now();
    if (delay <= 0) {
      flip();
      return;
    }
    // Beyond setTimeout's 32-bit range the card re-renders long before then.
    if (delay > 2_147_483_647) return;
    const timer = setTimeout(flip, delay);
    return () => clearTimeout(timer);
  }, [resetAtMs]);
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
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    }
  }
  async function moveToAnotherAccount() {
    if (boxManagerId === null) return;
    setSwitching(true);
    setError(null);
    setSwitchedNotice(null);
    const result = await switchAccount({
      environmentId: boxManagerId,
      input: { environmentId, threadId: thread.id },
    });
    setSwitching(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not switch accounts.");
      return;
    }
    const { switched, title, description } = describeAccountSwitch(result.value);
    if (switched) setSwitchedNotice(`${title}. ${description}`);
    else setError(description);
  }
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3">
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
                disabled={pending || switching || (!snoozed && resetPassed)}
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
