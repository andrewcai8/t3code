import { CloudIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

export type CloudEnvironmentSetupPhase =
  | "creating"
  | "pairing"
  | "loading-project"
  | "ready"
  | "failed";

export interface CloudEnvironmentSetupSnapshot {
  readonly provider: "e2b" | "namespace";
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
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}

export function environmentSetupHeader(snapshot: CloudEnvironmentSetupSnapshot): string {
  switch (snapshot.phase) {
    case "creating":
      return "Preparing environment";
    case "pairing":
      return "Connecting environment";
    case "loading-project":
      return "Loading project";
    case "ready":
      return "Environment ready";
    case "failed":
      return "Environment setup failed";
  }
}

export function environmentSetupDescription(snapshot: CloudEnvironmentSetupSnapshot): string {
  if (snapshot.phase === "failed") {
    return snapshot.error ?? "Could not prepare the environment.";
  }
  if (snapshot.phase === "creating" && snapshot.repository) {
    return `Setting up the environment and cloning ${snapshot.repository}.`;
  }
  switch (snapshot.phase) {
    case "creating":
      return "Setting up the environment. This can take a few minutes.";
    case "pairing":
      return "Adding the new environment to this chat.";
    case "loading-project":
      return "Waiting for the checkout to appear.";
    case "ready":
      return "Sending your first message.";
  }
}

export function EnvironmentSetupCard({ snapshot, onCancel }: EnvironmentSetupCardProps) {
  const running = snapshot.phase !== "ready" && snapshot.phase !== "failed";
  const nowMs = useNowWhile(running);
  const totalElapsed = (() => {
    const start = Date.parse(snapshot.startedAt);
    const end = snapshot.endedAt ? Date.parse(snapshot.endedAt) : nowMs;
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  })();
  const failed = snapshot.phase === "failed";
  const providerLabel = snapshot.provider === "namespace" ? "Namespace Mac" : "E2B";

  return (
    <section
      aria-label="Environment setup"
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
            <CloudIcon aria-hidden className="size-4 shrink-0 stroke-[1.8]" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{environmentSetupHeader(snapshot)}</span>
        {totalElapsed !== null ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatDuration(totalElapsed)}
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 px-0.5 pl-8 text-xs text-muted-foreground">
        {environmentSetupDescription(snapshot)}
      </p>
      <p className="mt-0.5 px-0.5 pl-8 text-xs text-muted-foreground">{providerLabel}</p>
      {onCancel && (running || failed) ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="flex-1" />
          <Button type="button" size="xs" variant="outline" onClick={onCancel}>
            <XIcon aria-hidden />
            {failed ? "Dismiss" : "Cancel"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
