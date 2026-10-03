import { useAtomValue } from "@effect/atom-react";
import { connectionStatusName } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "../../connection/catalog";

/** What the connection status calls `environmentId`: a cloud box goes by its role. */
export function useConnectionStatusLabel(
  environmentId: EnvironmentId | null,
  environmentLabel: string | null,
): string | null {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const target = environmentId === null ? undefined : catalog.entries.get(environmentId)?.target;
  return target === undefined ? environmentLabel : connectionStatusName(target);
}
