import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { limitsNotice } from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import cursorPeriod from "../testFixtures/cursor/period.json" with { type: "json" };
import { readCursorUsageLimits } from "./cursorUsageLimits.ts";

it.effect("gives each Cursor pool the billing cycle's pace marker", () =>
  Effect.gen(function* () {
    const limits = yield* readCursorUsageLimits(
      { apiEndpoint: "" },
      { CURSOR_AUTH_TOKEN: "token" },
    ).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(cursorPeriod))),
        ),
      ),
      Effect.provide(NodeServices.layer),
    );
    expect(
      limits.windows.map(({ id, usedPercent, windowDurationMins }) => ({
        id,
        usedPercent,
        windowDurationMins,
      })),
    ).toEqual(
      expect.arrayContaining([
        { id: "totalPercentUsed", usedPercent: 78.14571428571429, windowDurationMins: 44640 },
        { id: "autoPercentUsed", usedPercent: 74.42733333333334, windowDurationMins: 44640 },
        { id: "apiPercentUsed", usedPercent: 100, windowDurationMins: 44640 },
      ]),
    );
    expect(limitsNotice(limits)).toBeNull();
  }),
);
