import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";
import { withoutArrivedCreations } from "./pending-new-task-arrivals";
import { environmentProjects } from "./projects";
import { environmentThreadShells } from "./threads";
import { useThreadOutboxMessages } from "./use-thread-outbox";

/** The project as the live client store holds it now. */
export function readProject(ref: ScopedProjectRef): EnvironmentProject | null {
  return appAtomRegistry.get(environmentProjects.projectAtom(ref));
}

/** Every project as the live client store holds them now. */
export function readProjects(): ReadonlyArray<EnvironmentProject> {
  return appAtomRegistry.get(environmentProjects.projectsAtom);
}

/**
 * Resolves with the first project on `environmentId`, or null once `timeoutMs` passes. A newly
 * paired cloud machine publishes its cloned project some moments after the connection opens;
 * this is how a caller waits for that without polling.
 */
export function waitForEnvironmentProject(
  environmentId: EnvironmentId,
  timeoutMs: number,
): Promise<EnvironmentProject | null> {
  const find = () =>
    appAtomRegistry
      .get(environmentProjects.projectsAtom)
      .find((project) => project.environmentId === environmentId) ?? null;
  const current = find();
  if (current !== null) return Promise.resolve(current);
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsubscribe?.();
      resolve(null);
    }, timeoutMs);
    const settle = () => {
      const project = find();
      if (project === null) return;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(project);
    };
    unsubscribe = appAtomRegistry.subscribe(environmentProjects.projectsAtom, settle);
    settle();
  });
}

/** The outbox's queued messages, less the creations whose thread already arrived. */
export function useQueuedMessagesAwaitingThreads() {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const threadRefs = useAtomValue(environmentThreadShells.threadRefsAtom);
  return useMemo(
    () => withoutArrivedCreations(queuedMessagesByThreadKey, threadRefs),
    [queuedMessagesByThreadKey, threadRefs],
  );
}
