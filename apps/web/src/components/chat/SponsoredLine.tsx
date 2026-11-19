import { type RunId } from "@t3tools/contracts";
import { T } from "gt-react";
import { use, useEffect, useEffectEvent } from "react";

import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TimelineRowActivityCtx, TimelineRowCtx } from "./timelineRowContext";

/** One dim line under the latest completed reply; the host decides whether a person's turn earns an ad. */
export function SponsoredLine({ runId }: { readonly runId: RunId | null }) {
  const { threadRef } = use(TimelineRowCtx);
  const { latestRunId, isWorking } = use(TimelineRowActivityCtx);
  const configs = useServerConfigs();
  const target =
    threadRef !== null &&
    runId !== null &&
    runId === latestRunId &&
    !isWorking &&
    configs.get(threadRef.environmentId)?.settings.sidequestEnabled === true
      ? { environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId, runId } }
      : null;
  const { data: ad } = useEnvironmentQuery(target && serverEnvironment.sidequestAd(target));
  const reportImpression = useAtomCommand(serverEnvironment.sidequestReportImpression, {
    reportFailure: false,
  });
  const impressionId = target === null ? undefined : ad?.impressionId;
  const report = useEffectEvent((id: string) => {
    if (target !== null)
      void reportImpression({ environmentId: target.environmentId, input: { impressionId: id } });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the host an ad rendered; the host dedupes by impression id
  useEffect(() => {
    if (impressionId !== undefined) report(impressionId);
  }, [impressionId]);

  if (target === null || !ad) return null;
  const text = `${ad.advertiser.name} · ${ad.adText}`;
  return (
    <Tooltip>
      <TooltipTrigger render={<p className="mt-1 truncate px-1 text-xs text-muted-foreground" />}>
        <T>Sponsored</T> · {text} ·{" "}
        <a
          href={ad.adLink}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2"
        >
          {ad.adCta}
        </a>
      </TooltipTrigger>
      <TooltipPopup>{`${text} · ${ad.adCta}`}</TooltipPopup>
    </Tooltip>
  );
}
