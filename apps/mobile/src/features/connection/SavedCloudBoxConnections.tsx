import { useAtomValue } from "@effect/atom-react";
import { connectionBox, isUnpairedBox } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { environmentCatalog } from "../../connection/catalog";
import { cn } from "../../lib/cn";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * The connections this phone saved as cloud boxes. They belong to chats and are listed nowhere
 * else, so one marked as a box by mistake is put right here: made an ordinary environment again,
 * or removed with its cached data.
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
    <View collapsable={false} className="mt-5 gap-3">
      <Text className="px-1 text-sm font-t3-bold uppercase text-foreground-muted">
        Cloud machine connections
      </Text>
      <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
        {boxes.map(({ environmentId, label, managerId }, index) => (
          <View
            key={environmentId}
            collapsable={false}
            className={cn("gap-2 px-4 py-3.5", index !== 0 && "border-t border-border")}
          >
            <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
              {label}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {`Started by ${catalog.entries.get(managerId)?.target.label ?? managerId} for one chat. It connects only while that chat needs it.`}
            </Text>
            <View className="flex-row gap-2">
              {[
                { label: "Not a cloud machine", action: () => unmark(environmentId) },
                { label: "Remove", action: () => remove(environmentId) },
              ].map((button) => (
                <Pressable
                  key={button.label}
                  accessibilityRole="button"
                  disabled={busy !== null}
                  onPress={() => void run(environmentId, button.action)}
                  className="rounded-full bg-subtle px-3.5 py-2 active:opacity-70 disabled:opacity-50"
                >
                  <Text className="text-xs font-t3-bold text-foreground">{button.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
