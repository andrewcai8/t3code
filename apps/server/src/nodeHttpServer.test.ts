// @effect-diagnostics nodeBuiltinImport:off - the layer under test serves a Node http.Server.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as NodeHttpServer from "./nodeHttpServer.ts";

describe("nodeHttpServer.layer", () => {
  it.live("keeps the platform's process spawner for services built under it", () =>
    Effect.gen(function* () {
      const hosted = ChildProcessSpawner.make(() => Effect.die("unused"));
      const platform = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, hosted).pipe(
        Layer.provideMerge(NodeServices.layer),
      );
      const seen = yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
        Effect.provide(
          NodeHttpServer.layer(() => NodeHttp.createServer(), { host: "127.0.0.1", port: 0 }).pipe(
            Layer.provideMerge(platform),
          ),
        ),
      );
      expect(seen).toBe(hosted);
    }),
  );
});
