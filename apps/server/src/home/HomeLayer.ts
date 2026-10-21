import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as FleetBroker from "./FleetBroker.ts";
import * as FleetService from "./FleetService.ts";
import * as HomeService from "./HomeService.ts";
import * as WorktreeForks from "./WorktreeForks.ts";

/** Home and fleet services, shared by the WebSocket, MCP and fork-exec transports. */
export const HomeLayer = Layer.mergeAll(
  HomeService.layer,
  FleetBroker.layer,
  FleetService.layer.pipe(Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry)),
  WorktreeForks.layer.pipe(Layer.provide(ProcessRunner.layer)),
);
