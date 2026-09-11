import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/**
 * Ask a manager for a cloud environment.
 *
 * The controls beside this one operate environments an operator declared in
 * advance. This asks for one that does not exist yet, which is what someone
 * wants when they are about to start work rather than resume it.
 *
 * The result is a pairing token, and a pairing token is single use, so it is
 * shown rather than spent: pairing here would hand back a dead link.
 */
export function NewCloudEnvironment({
  managerId,
  managerLabel,
}: {
  managerId: EnvironmentId;
  managerLabel: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(managerId));
  const provision = useAtomCommand(serverEnvironment.provisionEnvironment, {
    reportFailure: false,
  });
  const accounts = (config?.providers ?? []).filter(
    (provider) => provider.enabled && provider.driver === "codex",
  );
  const [account, setAccount] = useState<string>("");
  const [repository, setRepository] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);

  if (config?.environmentControl !== true || accounts.length === 0) return null;
  const chosen = account || accounts[0]?.instanceId || "";

  async function create() {
    setBusy(true);
    setMessage(null);
    setPairingUrl(null);
    try {
      const result = await provision({
        environmentId: managerId,
        input: {
          provider: "e2b" as const,
          providerInstanceId: chosen,
          ...(repository.trim() ? { repository: repository.trim() } : {}),
        },
      });
      if (AsyncResult.isFailure(result)) {
        setMessage("The manager could not be reached. Refresh and try again.");
        return;
      }
      if (result.value.kind === "refused") {
        setMessage(result.value.message);
        return;
      }
      setPairingUrl(result.value.environment.pairingUrl);
      setMessage("Ready. Open this link, or paste it into Add environment, to connect.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-border px-4 py-3">
      <p className="text-xs text-muted-foreground">New cloud environment via {managerLabel}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="cloud-account" className="text-xs">
            Account
          </Label>
          <select
            id="cloud-account"
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            value={chosen}
            disabled={busy}
            onChange={(event) => setAccount(event.target.value)}
          >
            {accounts.map((provider) => (
              <option key={provider.instanceId} value={provider.instanceId}>
                {provider.displayName ?? provider.instanceId}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cloud-repository" className="text-xs">
            Repository (optional)
          </Label>
          <Input
            id="cloud-repository"
            className="h-8 w-56 text-sm"
            placeholder="owner/name"
            value={repository}
            disabled={busy}
            onChange={(event) => setRepository(event.target.value)}
          />
        </div>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void create()}>
          {busy ? "Creating…" : "Create"}
        </Button>
      </div>
      {pairingUrl ? (
        <p className="break-all text-xs">
          <a className="underline" href={pairingUrl} target="_blank" rel="noreferrer">
            {pairingUrl}
          </a>
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
