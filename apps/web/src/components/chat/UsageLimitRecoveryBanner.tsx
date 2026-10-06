import { describeAccountSwitch } from "@t3tools/client-runtime/cloud";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type EnvironmentProvisionSwitchAccountInput,
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryProps = {
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  /** The host request that moves this chat onto another account; null off a cloud box. */
  accountSwitch: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentProvisionSwitchAccountInput;
  } | null;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, resetAt, stoppedAt } = props;
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    priority: "urgent",
    icon: <GaugeIcon />,
    title: "Usage limit reached",
    description: resetAt
      ? `Resets ${new Date(resetAt).toLocaleString()}`
      : "Reset time unavailable; retry manually",
    actions:
      canSchedule || props.accountSwitch !== null ? (
        <RecoveryActions key={`${runId}:${resetAt}`} canSchedule={canSchedule} {...props} />
      ) : null,
  };
}

function RecoveryActions({
  runId,
  resetAt,
  recovery,
  snoozedUntil,
  onChange,
  accountSwitch,
  canSchedule,
}: RecoveryProps & { canSchedule: boolean }) {
  const switchAccount = useAtomCommand(serverEnvironment.switchProvisionedAccount, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const delay = Date.parse(resetAt ?? "") - Math.max(nowMs, Date.now());
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.min(delay + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [resetAt, nowMs]);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    snoozedUntil !== null &&
    Date.parse(snoozedUntil) === Date.parse(resetAt);
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      setError("The reset time has passed. Retry the thread manually.");
      setNowMs(Date.now());
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onChange({
        runId,
        resetAt,
        ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    }
    setPending(false);
  }
  async function moveToAnotherAccount() {
    if (accountSwitch === null) return;
    setSwitching(true);
    setError(null);
    const result = await switchAccount(accountSwitch);
    setSwitching(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not switch accounts.");
      return;
    }
    const { switched, title, description } = describeAccountSwitch(result.value);
    toastManager.add({ type: switched ? "success" : "error", title, description });
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canSchedule ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || switching}
          onClick={() => void toggle("resume")}
        >
          {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
        </Button>
      ) : null}
      {canSchedule && !snoozed ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || switching || Date.parse(resetAt!) <= nowMs}
          onClick={() => void toggle("snooze")}
        >
          {pending ? "Saving..." : "Snooze until reset"}
        </Button>
      ) : null}
      {accountSwitch !== null ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || switching}
          onClick={() => void moveToAnotherAccount()}
        >
          {switching ? "Switching..." : "Switch account"}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
