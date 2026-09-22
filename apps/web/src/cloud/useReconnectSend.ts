import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProvisionedEnvironmentRecovery } from "./provisionedEnvironmentRecovery";

export function useReconnectSend<Input>(options: {
  threadKey: string;
  ready: boolean;
  recover: (environmentId: EnvironmentId) => Promise<ProvisionedEnvironmentRecovery>;
  send: (input: Input) => void;
  onFailure: (message: string) => void;
}) {
  type Pending = { threadKey: string; input: Input; ready: boolean };
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const { threadKey, ready, recover, send, onFailure } = options;
  const reconnectAndSend = useCallback(
    async (environmentId: EnvironmentId, input: Input) => {
      if (pendingRef.current) return;
      const request = { threadKey, input, ready: false };
      pendingRef.current = request;
      setPending(request);
      const recovered = await recover(environmentId);
      if (pendingRef.current !== request) return;
      if (recovered.kind === "ready") {
        const next = { ...request, ready: true };
        pendingRef.current = next;
        setPending(next);
      } else {
        pendingRef.current = null;
        setPending(null);
        onFailure(
          recovered.kind === "failed"
            ? recovered.message
            : "This environment is not connected. Reconnect it, then send again.",
        );
      }
    },
    [threadKey, recover, onFailure],
  );

  useEffect(() => {
    if (!pending || pendingRef.current !== pending) return;
    if (pending.threadKey !== threadKey) {
      pendingRef.current = null;
      setPending(null);
      return;
    }
    if (!pending.ready || !ready) return;
    pendingRef.current = null;
    setPending(null);
    send(pending.input);
  }, [pending, threadKey, ready, send]);
  useEffect(
    () => () => {
      pendingRef.current = null;
    },
    [],
  );
  const isPending = useCallback(() => pendingRef.current !== null, []);
  return { reconnectAndSend, reconnecting: pending !== null, isPending };
}
