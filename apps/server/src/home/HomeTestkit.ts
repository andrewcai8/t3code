import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as FleetBroker from "./FleetBroker.ts";
import * as FleetService from "./FleetService.ts";
import * as HomeService from "./HomeService.ts";
import * as WorktreeForks from "./WorktreeForks.ts";

/** Home services for tests whose caller is never Home, on a host without worktree forks. */
export const notHomeLayer = Layer.mergeAll(
  Layer.mock(HomeService.HomeService)({
    available: false,
    isHome: () => Effect.succeed(false),
  }),
  Layer.mock(FleetService.FleetService)({}),
  Layer.mock(FleetBroker.FleetBroker)({
    reach: Effect.succeed({ hostConnected: false, environments: [] }),
  }),
  Layer.mock(WorktreeForks.WorktreeForks)({ enabled: false, bunShim: null }),
);
