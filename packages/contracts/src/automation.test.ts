import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AutomationInput, AutomationSchedule } from "./automation.ts";

const decode = Schema.decodeUnknownExit(AutomationSchedule);

describe("AutomationSchedule", () => {
  it("accepts a five-field cron in an IANA zone and rejects seconds or unknown zones", () => {
    expect(decode({ cron: "0 9 * * 1-5", timeZone: "America/New_York" })._tag).toBe("Success");
    expect(decode({ cron: "0 0 9 * * 1-5", timeZone: "America/New_York" })._tag).toBe("Failure");
    expect(decode({ cron: "0 9 * * 1-5", timeZone: "Mars/Olympus" })._tag).toBe("Failure");
    expect(decode({ cron: "61 9 * * *", timeZone: "UTC" })._tag).toBe("Failure");
  });

  it("refuses schedules that fire less than 15 minutes apart", () => {
    const verdict = (cron: string) => decode({ cron, timeZone: "UTC" })._tag;
    expect(
      [
        "*/15 * * * *",
        "*/10 * * * *",
        "0,50 9 * * *",
        "50 9,10 * * *",
        "0,50 9-10 * * *",
        "* 9 * * *",
      ].map(verdict),
    ).toEqual(["Success", "Failure", "Success", "Success", "Failure", "Failure"]);
  });
});

describe("AutomationInput", () => {
  it("reads an input from a client that predates the model pick as the default model", () => {
    const decoded = Schema.decodeUnknownSync(AutomationInput)({
      name: "Nightly",
      repository: "andrewcai8/t3code",
      branch: null,
      prompt: "Bump dependencies.",
      agentDriver: "codex",
      account: null,
      provider: "e2b",
      schedule: null,
      webhook: false,
      enabled: true,
    });
    expect(decoded.model).toBe(null);
  });
});
