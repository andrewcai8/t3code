import * as Equal from "effect/Equal";
import * as Stream from "effect/Stream";

import type { PlatformConnectionRegistration } from "./catalog.ts";
import type * as EnvironmentRegistry from "./registry.ts";

/**
 * Applies the platform's registrations to the registry when they change. The platform is polled,
 * so most reports repeat the last one, and reconciling those would do nothing but record spans.
 */
export const followPlatformRegistrations = (
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  registrations: Stream.Stream<ReadonlyArray<PlatformConnectionRegistration>>,
) =>
  registrations.pipe(
    Stream.changesWith(
      (previous, next) =>
        previous.length === next.length &&
        previous.every((registration, index) => Equal.equals(registration, next[index])),
    ),
    Stream.runForEach(registry.reconcilePlatform),
  );
