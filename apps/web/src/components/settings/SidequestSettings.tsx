import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SidequestConnection } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const PENDING_REFRESH_MS = 2000;

const STATUS_TEXT = {
  disconnected: "Not connected. No sponsored line shows until you connect a Sidequest account.",
  suspended: "This Sidequest device is suspended.",
  unavailable: "Sidequest is unreachable or not available in your region right now.",
} as const;

export function SidequestRow() {
  const { scope, environment } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("sidequest-sponsored")}
      settingKeys={["sidequestEnabled"]}
      description="Show one dim sponsored line under the latest reply you typed a prompt for. It appears only while this machine is connected to a Sidequest account."
      control={
        <ScopedSwitch
          settingKeys={["sidequestEnabled"]}
          checked={settings.sidequestEnabled}
          onCheckedChange={(checked) => updateSettings({ sidequestEnabled: Boolean(checked) })}
          aria-label="Sponsored line under replies"
        />
      }
    >
      {scope.kind === "environment" && environment ? (
        <SidequestConnectionControls
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Choose one environment to connect its Sidequest account.
        </p>
      )}
    </SettingsRow>
  );
}

function SidequestConnectionControls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canManage = useAtomValue(serverEnvironment.sidequestConnect.permissionAtom(environmentId));
  const getConnection = useAtomCommand(serverEnvironment.sidequestGetConnection, {
    reportFailure: false,
  });
  const connect = useAtomCommand(serverEnvironment.sidequestConnect);
  const disconnect = useAtomCommand(serverEnvironment.sidequestDisconnect);
  const [connection, setConnection] = useState<SidequestConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = connection?.status === "pending";

  const refresh = useEffectEvent(async () => {
    const result = await getConnection({ environmentId, input: {} });
    if (result._tag === "Success") setConnection(result.value);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the host's Sidequest status and polls it only while a connect code is pending
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    void refresh();
    if (!pending) return;
    const interval = setInterval(() => void refresh(), PENDING_REFRESH_MS);
    return () => clearInterval(interval);
  }, [pending]);

  const run = async (command: typeof connect) => {
    setBusy(true);
    const result = await command({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Success") setConnection(result.value);
  };

  return (
    <div className="mt-2 grid gap-2 text-xs text-muted-foreground">
      {connection === null ? null : connection.status === "connected" ? (
        <p>Connected as {connection.email}.</p>
      ) : connection.status === "pending" ? (
        <PendingConnect connection={connection} />
      ) : (
        <p>{STATUS_TEXT[connection.status]}</p>
      )}
      {!canManage || connection === null ? null : (
        <div className="flex gap-2">
          {connection.status === "connected" || connection.status === "suspended" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void run(disconnect)}
            >
              Disconnect
            </Button>
          ) : (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void run(connect)}>
              {connection.status === "pending" ? "Restart connect" : "Connect"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function PendingConnect({
  connection,
}: {
  readonly connection: Extract<SidequestConnection, { status: "pending" }>;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "Sidequest code" });
  return (
    <div className="grid gap-1.5">
      <p>
        Open the link, sign in to Sidequest, and enter the code{" "}
        <code className="font-mono text-foreground">{connection.userCode}</code>. This page updates
        when it connects.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={connection.connectUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all underline underline-offset-2"
        >
          {connection.connectUrl}
        </a>
        <Button
          size="xs"
          variant="outline"
          onClick={() => copyToClipboard(connection.userCode, undefined)}
        >
          {isCopied ? "Copied" : "Copy code"}
        </Button>
      </div>
    </div>
  );
}
