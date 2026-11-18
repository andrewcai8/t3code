import * as Schema from "effect/Schema";

import { RunId, ThreadId } from "./baseSchemas.ts";

export const SidequestConnection = Schema.Union([
  Schema.Struct({ status: Schema.Literal("disconnected") }),
  Schema.Struct({
    status: Schema.Literal("pending"),
    connectUrl: Schema.String,
    userCode: Schema.String,
    expiresAt: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("connected"), email: Schema.String }),
  Schema.Struct({ status: Schema.Literal("suspended") }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
export type SidequestConnection = typeof SidequestConnection.Type;

const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\/[^\s/?#]+\S*$/u));

export const SidequestAd = Schema.Struct({
  adText: Schema.String,
  adCta: Schema.String,
  adLink: HttpsUrl,
  impressionId: Schema.String,
  advertiser: Schema.Struct({
    name: Schema.String,
    iconUrl: Schema.optional(Schema.String),
    rootDomain: Schema.optional(Schema.String),
  }),
});
export type SidequestAd = typeof SidequestAd.Type;

export const SidequestFetchAdInput = Schema.Struct({ threadId: ThreadId, runId: RunId });
export type SidequestFetchAdInput = typeof SidequestFetchAdInput.Type;

export const SidequestReportImpressionInput = Schema.Struct({ impressionId: Schema.String });
export type SidequestReportImpressionInput = typeof SidequestReportImpressionInput.Type;
