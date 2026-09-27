import { useAtomValue } from "@effect/atom-react";
import { offeredProvisionProviders } from "@t3tools/client-runtime/cloud";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { useMemo } from "react";

import { serverEnvironment } from "../../state/server";

/**
 * Every cloud box the hosts among `serverConfigs` report. A phone that joined a box through a
 * pairing link keeps no record that it is a box, so the host that provisioned it is the only
 * place to ask.
 */
export function useProvisionedBoxes(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
): ReadonlySet<EnvironmentId> {
  const hostIds = useMemo(
    () =>
      [...serverConfigs].flatMap(([environmentId, config]) =>
        offeredProvisionProviders(config).length > 0 ? [environmentId] : [],
      ),
    [serverConfigs],
  );
  const boxes = useAtomValue(serverEnvironment.provisionedBoxes(hostIds));
  return useMemo(() => new Set(boxes.map((box) => box.environmentId)), [boxes]);
}
