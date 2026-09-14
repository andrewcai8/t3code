// @effect-diagnostics globalDate:off - provider SDK boundaries use the wall clock for relative timeouts.
import * as Data from "effect/Data";

/** E2B accepts relative whole seconds; leave room for transport before checking its actual deadline. */
const TRANSPORT_MARGIN_MS = 1_000;

export class ProvisionRetentionError extends Data.TaggedError("ProvisionRetentionError")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "The provider retention deadline could not be enforced." });
  }
}

export function retentionExpired(deadline: string | undefined, now: number): boolean {
  return deadline !== undefined && Date.parse(deadline) <= now;
}

export function retentionTimeoutMs(
  deadline: string | undefined,
  requestedMs: number,
  now = Date.now(),
): number {
  if (deadline === undefined) return requestedMs;
  const seconds = Math.floor(
    (Math.min(requestedMs, Date.parse(deadline) - now) - TRANSPORT_MARGIN_MS) / 1_000,
  );
  if (seconds <= 0) throw new ProvisionRetentionError();
  return seconds * 1_000;
}

export async function verifyRetentionDeadline(
  deadline: string | undefined,
  port: {
    readonly read: () => Promise<Date>;
    readonly shorten: (timeoutMs: number) => Promise<void>;
  },
): Promise<void> {
  if (deadline === undefined) return;
  try {
    const cap = Date.parse(deadline);
    let actual = (await port.read()).getTime();
    if (actual > cap) {
      await port.shorten(retentionTimeoutMs(deadline, Number.MAX_SAFE_INTEGER));
      actual = (await port.read()).getTime();
    }
    if (
      !Number.isFinite(actual) ||
      actual > cap ||
      actual <= Date.now() ||
      retentionExpired(deadline, Date.now())
    )
      throw new ProvisionRetentionError();
  } catch {
    throw new ProvisionRetentionError();
  }
}
