import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { UsageService } from "./UsageService.ts";

export const usageHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "usage",
  Effect.fnUntraced(function* (handlers) {
    const usage = yield* UsageService;
    return handlers.handle(
      "history",
      Effect.fn("environment.usage.history")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* usage
          .readHistory(args.payload)
          .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
      }),
    );
  }),
);
