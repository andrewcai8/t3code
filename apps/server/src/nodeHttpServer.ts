import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Etag from "effect/http/Etag";
import * as Layer from "effect/Layer";

/**
 * `NodeHttpServer.layer` without the NodeServices it also outputs. Those carry Node's own
 * ChildProcessSpawner, which would replace the spawn host's for every service built under the
 * HTTP server, so the git driver would fork the whole server again on Linux.
 */
export const layer = (...args: Parameters<typeof NodeHttpServer.layerServer>) =>
  Layer.mergeAll(NodeHttpServer.layerServer(...args), NodeHttpPlatform.layer, Etag.layerWeak);
