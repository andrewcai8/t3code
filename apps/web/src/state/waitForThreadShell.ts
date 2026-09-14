import type { ScopedThreadRef } from "@t3tools/contracts";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "./threads";

export async function waitForThreadShell(
  ref: ScopedThreadRef,
  timeoutMs = 15_000,
): Promise<boolean> {
  const atom = environmentThreadShells.threadShellAtom(ref);
  if (appAtomRegistry.get(atom) !== null) return true;
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = appAtomRegistry.subscribe(atom, (thread) => {
      if (thread !== null) finish(true);
    });
    function finish(available: boolean) {
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve(available);
    }
    if (appAtomRegistry.get(atom) !== null) finish(true);
  });
}
