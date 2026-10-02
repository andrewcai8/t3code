import { useAtomValue } from "@effect/atom-react";
import { connectionBox, isUnpairedBox } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * The connections this device saved as cloud boxes. They belong to chats and are listed nowhere
 * else, so a connection marked as a box by mistake is put right here: made an ordinary
 * environment again, or removed with its cached data.
 */
export function SavedCloudBoxConnections() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const unmark = useAtomCommand(environmentCatalog.unmarkBox);
  const remove = useAtomCommand(environmentCatalog.remove);
  const [busy, setBusy] = useState<EnvironmentId | null>(null);
  const boxes = [...catalog.entries].flatMap(([environmentId, entry]) => {
    const box = connectionBox(entry.target);
    // A box only listed from its host is the host's to show, and has no pairing here to fix.
    return box === null || isUnpairedBox(entry)
      ? []
      : [{ environmentId, label: entry.target.label, managerId: box.managerId }];
  });
  if (boxes.length === 0) return null;
  const run = async (environmentId: EnvironmentId, action: () => Promise<unknown>) => {
    setBusy(environmentId);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };
  return (
    <SettingsSection title="Cloud machine connections">
      {boxes.map(({ environmentId, label, managerId }) => {
        const host = catalog.entries.get(managerId)?.target.label ?? managerId;
        return (
          <SettingsRow
            key={environmentId}
            title={label}
            description={`A cloud machine ${host} started for one chat. It connects only while that chat needs it.`}
            control={
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void run(environmentId, () => unmark(environmentId))}
                >
                  Not a cloud machine
                </Button>
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={busy !== null}
                  onClick={() => void run(environmentId, () => remove(environmentId))}
                >
                  Remove
                </Button>
              </div>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
