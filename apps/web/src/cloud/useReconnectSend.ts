import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

export type ReconnectResult =
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly message: string };

export function useReconnectSend<Input>(options: {
  threadKey: string;
  ready: boolean;
  recover: (environmentId: EnvironmentId) => Promise<ReconnectResult>;
  send: (input: Input) => void;
  onFailure: (message: string) => void;
  /** The user left the thread before its send went out; the message stays in its draft. */
  onAbandoned: () => void;
}) {
  type Pending = { threadKey: string; input: Input; ready: boolean };
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const { threadKey, ready, recover, send, onFailure, onAbandoned } = options;
  const reconnectAndSend = async (environmentId: EnvironmentId, input: Input) => {
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
      onFailure(recovered.message);
    }
  };

  // oxlint-disable-next-line t3code/react-effect-budget -- Releases the held send once the thread is ready, or abandons it when the user navigated to another thread.
  useEffect(() => {
    if (!pending || pendingRef.current !== pending) return;
    if (pending.threadKey !== threadKey) {
      pendingRef.current = null;
      // oxlint-disable-next-line react/set-state-in-effect -- The abandon notice below must run once, after the navigation commits.
      setPending(null);
      onAbandoned();
      return;
    }
    if (!pending.ready || !ready) return;
    pendingRef.current = null;
    setPending(null);
    send(pending.input);
  }, [pending, threadKey, ready, send, onAbandoned]);
  const onAbandonedRef = useRef(onAbandoned);
  // oxlint-disable-next-line t3code/react-effect-budget -- Keeps the latest abandon callback for the unmount cleanup below, which must not resubscribe.
  useEffect(() => {
    onAbandonedRef.current = onAbandoned;
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- Reports an abandoned send when the page unmounts while one is still waiting.
  useEffect(
    () => () => {
      if (pendingRef.current === null) return;
      pendingRef.current = null;
      onAbandonedRef.current();
    },
    [],
  );
  const isPending = () => pendingRef.current !== null;
  /** Stops waiting to send; the message stays in the composer. */
  const cancel = () => {
    pendingRef.current = null;
    setPending(null);
  };
  return { reconnectAndSend, reconnecting: pending !== null, isPending, cancel };
}
