#!/usr/bin/env node
// A Claude CLI signed in the way a cloud host signs in: a setup-token in
// CLAUDE_CODE_OAUTH_TOKEN that get_usage cannot read, whose turns report the
// account's windows in rate_limit_event. The weekly window is the token's
// FAKE_WEEKLY_<token> variable, so each account reads its own.
import * as NodeReadline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("claude 2.1.285\n");
  process.exit(0);
}
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
const weekly = Number(process.env[`FAKE_WEEKLY_${token}`] ?? "NaN");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const answer = (request, response) =>
  write({
    type: "control_response",
    response: { subtype: "success", request_id: request.request_id, response },
  });

const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "user") {
    write({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: {
          five_hour: { utilization: 0, resetsAt: 1_790_207_400 },
          seven_day: { utilization: weekly, resetsAt: 1_790_672_400 },
        },
      },
      uuid: "00000000-0000-4000-8000-000000000001",
      session_id: "00000000-0000-4000-8000-000000000002",
    });
    return;
  }
  if (message.type !== "control_request") return;
  if (message.request?.subtype === "get_usage") {
    answer(message, { session: {}, rate_limits_available: false, rate_limits: null });
    return;
  }
  if (message.request?.subtype !== "initialize") return;
  answer(message, {
    commands: [],
    agents: [],
    models: [],
    output_style: "default",
    available_output_styles: ["default"],
    account: token
      ? { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" }
      : { tokenSource: "none" },
  });
});
const keepAlive = setInterval(() => {}, 1_000);
lines.on("close", () => {
  clearInterval(keepAlive);
  process.exit(0);
});
