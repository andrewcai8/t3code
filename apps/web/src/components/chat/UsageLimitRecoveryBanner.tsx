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
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { deadlineStore } from "@t3tools/client-runtime/clock";
import { limitRecoveryOwnsSnooze } from "@t3tools/client-runtime/state/thread-execution";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";
import { useDeadlinePassed } from "../../hooks/useDeadline";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { Button, InlineButton } from "../ui/button";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { copyAdminRequest } from "./ThreadErrorBanner";

type RecoveryProps = {
  runId: RunId;
  errorCode: string | null;
  resetAt: string | null;
  stoppedAt: string;
  settled: boolean;
  requestPending: boolean;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  timestampFormat: TimestampFormat;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  /** The host request that moves this chat onto another account; null off a cloud box. */
  accountSwitch: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentProvisionSwitchAccountInput;
  } | null;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const {
    runId,
    errorCode,
    resetAt,
    stoppedAt,
    settled,
    requestPending,
    recovery,
    snoozedUntil,
    timestampFormat,
  } = props;
  // The server refuses recovery changes while a request is pending.
  const canSchedule =
    !settled && !requestPending && resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  const resumes =
    canSchedule && recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const workspaceLimit = errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || errorCode === CHATGPT_USAGE_LIMIT_CODE;
  const recoveryActions =
    canSchedule || props.accountSwitch !== null ? (
      <RecoveryActions key={`${runId}:${resetAt}`} canSchedule={canSchedule} {...props} />
    ) : null;
  const displayAt =
    resumes && resetAt && snoozedUntil && Date.parse(snoozedUntil) > Date.parse(resetAt)
      ? snoozedUntil
      : resetAt;
  const resetDescription = displayAt
    ? `${resumes ? "Resumes" : "Resets"} ${formatUpcomingTimestamp(displayAt, timestampFormat)}`
    : "Reset time unavailable; retry manually";
  if (!chatGptLimit) {
    return {
      id: `usage-limit-recovery:${runId}`,
      variant: "warning",
      group: "environment",
      icon: <GaugeIcon />,
      title: "Usage limit reached",
      description: resetDescription,
      actions: recoveryActions,
    };
  }
  // OpenAI's partner guidelines specify this ChatGPT notice and its actions.
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    group: "environment",
    icon: <OpenAI aria-hidden="true" />,
    title: "ChatGPT usage limit reached",
    description: workspaceLimit
      ? "You've reached your workspace's limit for using your ChatGPT plan in other apps."
      : resetDescription,
    actions: (
      <>
        {recoveryActions}
        {workspaceLimit ? (
          <Button size="xs" variant="ghost" onClick={copyAdminRequest}>
            Copy request for admin
          </Button>
        ) : (
          <ChatGptUsageButton size="xs" variant="ghost" />
        )}
      </>
    ),
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

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  // The server leaves snoozedUntil in place after the timer wakes the thread,
  // so a snooze whose reset has passed is no longer active.
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const snoozed =
    limitRecoveryOwnsSnooze({ runId, resetAt, recovery, snoozedUntil }) && !resetPassed;
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      toastManager.add({
        type: "error",
        title: "Could not snooze thread",
        description: "The reset time has passed. Retry the thread manually.",
      });
      // The deadline timer can lag after a throttled tab or sleep; disable now.
      deadlineStore(Date.parse(resetAt)).refresh();
      return;
    }
    setPending(true);
    try {
      await onChange({
        runId,
        resetAt,
        ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: action === "resume" ? "Could not change auto-resume" : "Could not snooze thread",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    setPending(false);
  }
  // Failures go to a toast: inline errors would widen the actions column and crush the title.
  async function moveToAnotherAccount() {
    if (accountSwitch === null) return;
    setSwitching(true);
    const result = await switchAccount(accountSwitch);
    setSwitching(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not switch accounts",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
      return;
    }
    const { switched, title, description } = describeAccountSwitch(result.value);
    toastManager.add({ type: switched ? "success" : "error", title, description });
  }
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
      {canSchedule ? (
        <InlineButton
          touchTarget="padded"
          disabled={pending || switching}
          onClick={() => void toggle("resume")}
        >
          {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
        </InlineButton>
      ) : null}
      {canSchedule ? (
        <InlineButton
          touchTarget="padded"
          disabled={pending || switching || (!snoozed && resetPassed)}
          onClick={() => void toggle("snooze")}
        >
          {pending ? "Saving..." : snoozed ? "Wake now" : "Snooze until reset"}
        </InlineButton>
      ) : null}
      {accountSwitch !== null ? (
        <InlineButton
          touchTarget="padded"
          disabled={pending || switching}
          onClick={() => void moveToAnotherAccount()}
        >
          {switching ? "Switching..." : "Switch account"}
        </InlineButton>
      ) : null}
    </span>
  );
}
