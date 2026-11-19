import { cloudEnvironmentLabel } from "@t3tools/client-runtime/cloud";
import type { ProvisionProvider } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { CloudIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { m, type MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";

export type CloudEnvironmentSetupPhase =
  | "creating"
  | "pairing"
  | "loading-project"
  | "ready"
  | "failed";

export interface CloudEnvironmentSetupSnapshot {
  readonly provider: ProvisionProvider;
  readonly phase: CloudEnvironmentSetupPhase;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly error?: string;
  readonly repository?: string;
}

interface EnvironmentSetupCardProps {
  snapshot: CloudEnvironmentSetupSnapshot;
  onCancel: (() => void) | null;
}

function useNowWhile(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Ticks a one-second clock only while setup runs; the interval is cleared when it ends or unmounts.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}

export function environmentSetupHeader(
  snapshot: CloudEnvironmentSetupSnapshot,
  resolve: MessageResolver = m,
): string {
  switch (snapshot.phase) {
    case "creating":
      return resolve(msg("Preparing environment"));
    case "pairing":
      return resolve(msg("Connecting environment"));
    case "loading-project":
      return resolve(msg("Loading project"));
    case "ready":
      return resolve(msg("Environment ready"));
    case "failed":
      return resolve(msg("Environment setup failed"));
  }
}

export function environmentSetupDescription(
  snapshot: CloudEnvironmentSetupSnapshot,
  resolve: MessageResolver = m,
): string {
  if (snapshot.phase === "failed") {
    return snapshot.error ?? resolve(msg("Could not prepare the environment."));
  }
  if (snapshot.phase === "creating" && snapshot.repository) {
    return resolve(
      msg("Setting up the environment and cloning {repository}.", {
        repository: snapshot.repository,
      }),
    );
  }
  switch (snapshot.phase) {
    case "creating":
      return resolve(msg("Setting up the environment. This can take a few minutes."));
    case "pairing":
      return resolve(msg("Adding the new environment to this chat."));
    case "loading-project":
      return resolve(msg("Waiting for the checkout to appear."));
    case "ready":
      return resolve(msg("Sending your first message."));
  }
}

function EnvironmentSetupCard({ snapshot, onCancel }: EnvironmentSetupCardProps) {
  const gt = useGT();
  const messages = useMessages();
  const running = snapshot.phase !== "ready" && snapshot.phase !== "failed";
  const nowMs = useNowWhile(running);
  const totalElapsed = (() => {
    const start = Date.parse(snapshot.startedAt);
    const end = snapshot.endedAt ? Date.parse(snapshot.endedAt) : nowMs;
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  })();
  const failed = snapshot.phase === "failed";
  const providerLabel = cloudEnvironmentLabel(snapshot.provider);

  return (
    <section
      aria-label={gt("Environment setup")}
      className="mt-3 rounded-lg border border-border bg-card/60 px-2.5 pt-1.5 pb-2"
      data-environment-setup-phase={snapshot.phase}
      data-environment-setup-provider={snapshot.provider}
    >
      <div
        className={cn(
          "flex min-h-6 items-center gap-1.5 px-0.5 text-sm",
          failed ? "text-destructive-foreground" : "text-secondary-label",
        )}
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
          {running ? (
            <Spinner className="size-4 shrink-0" />
          ) : (
            <CloudIcon aria-hidden className="size-4 shrink-0" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {environmentSetupHeader(snapshot, messages)}
        </span>
        {totalElapsed !== null ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatDuration(totalElapsed)}
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 px-0.5 pl-8 text-xs text-muted-foreground">
        {environmentSetupDescription(snapshot, messages)}
      </p>
      <p className="mt-0.5 px-0.5 pl-8 text-xs text-muted-foreground">{providerLabel}</p>
      {onCancel && (running || failed) ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="flex-1" />
          <Button type="button" size="xs" variant="outline" onClick={onCancel}>
            <XIcon aria-hidden />
            {failed ? gt("Dismiss") : gt("Cancel")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** The setup card as the timeline's footer, laid out like a timeline row. */
export function EnvironmentSetupFooter({
  snapshot,
  onCancel,
}: {
  snapshot: CloudEnvironmentSetupSnapshot;
  onCancel: () => void;
}) {
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane overflow-x-clip pb-2" data-timeline-root="true">
        <EnvironmentSetupCard
          snapshot={snapshot}
          onCancel={snapshot.phase === "ready" ? null : onCancel}
        />
      </div>
    </div>
  );
}
