import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/** The stable log message every provisioning phase shares, so one grep reads a whole provision back. */
const PROVISION_PHASE_MESSAGE = "provision phase";

/** One completed provisioning phase. `bytes`/`count` are set only where a size is meaningful. */
export interface ProvisionPhase {
  readonly phase: string;
  readonly durationMs: number;
  readonly bytes?: number;
  readonly count?: number;
}
export type RecordProvisionPhase = (phase: ProvisionPhase) => void;
export interface ProvisionPhaseContext {
  readonly requestId: string;
  readonly provider: string;
}

/**
 * A stopwatch rather than a wrapper, so a call site can attach a size it only
 * learns after the work. A step that throws never reaches its stop, so only
 * completed phases are recorded.
 */
export const startProvisionPhase = (record: RecordProvisionPhase | undefined) => {
  const started = performance.now();
  return (phase: string, fields?: { readonly bytes?: number; readonly count?: number }) => {
    record?.({ phase, durationMs: Math.round(performance.now() - started), ...fields });
  };
};

const annotations = (context: ProvisionPhaseContext, phase: ProvisionPhase) => ({
  ...context,
  phase: phase.phase,
  durationMs: phase.durationMs,
  ...(phase.bytes === undefined ? {} : { bytes: phase.bytes }),
  ...(phase.count === undefined ? {} : { count: phase.count }),
});

export const logProvisionPhases = (
  context: ProvisionPhaseContext,
  phases: Iterable<ProvisionPhase>,
): Effect.Effect<void> =>
  Effect.forEach(
    phases,
    (phase) =>
      Effect.logInfo(PROVISION_PHASE_MESSAGE).pipe(
        Effect.annotateLogs(annotations(context, phase)),
      ),
    { discard: true },
  );

export const timeProvisionPhase =
  (phase: string, context: ProvisionPhaseContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Clock.currentTimeMillis, (started) =>
      Effect.onExit(effect, (exit) =>
        Effect.flatMap(Clock.currentTimeMillis, (ended) =>
          Effect.logInfo(PROVISION_PHASE_MESSAGE).pipe(
            Effect.annotateLogs({
              ...context,
              phase,
              durationMs: ended - started,
              ...(Exit.isSuccess(exit) ? {} : { failed: true }),
            }),
          ),
        ),
      ),
    );
