import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderAdapterRequestError,
  ProviderSessionNotFoundError,
  ProviderValidationError,
  ProviderWorkspaceMissingError,
} from "./Errors.ts";
import {
  describeUnavailableProviderInstance,
  providerFailureDetail,
} from "./providerFailureDetail.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const cursor = ProviderDriverKind.make("cursor");

const looksLikeAStack = (text: string) =>
  text.includes("file://") || text.includes(" at ") || /:\d+:\d+/.test(text);

describe("describeUnavailableProviderInstance", () => {
  it("names the one agent the environment offers", () => {
    const detail = describeUnavailableProviderInstance({
      requested: { instanceId: ProviderInstanceId.make("codex"), driver: codex },
      offered: [{ instanceId: ProviderInstanceId.make("claudeAgent"), driver: claude }],
    });
    expect(detail).toBe("Codex is not available in this environment. Use Claude instead.");
  });

  it("lists every agent the environment offers", () => {
    const detail = describeUnavailableProviderInstance({
      requested: { instanceId: ProviderInstanceId.make("codex"), driver: codex },
      offered: [
        { instanceId: ProviderInstanceId.make("claudeAgent"), driver: claude },
        { instanceId: ProviderInstanceId.make("codex_personal"), driver: codex },
        { instanceId: ProviderInstanceId.make("cursor"), driver: cursor },
      ],
    });
    expect(detail).toBe(
      "Codex is not available in this environment. Use Claude, Codex Personal, or Cursor instead.",
    );
  });

  it("names an instance the environment has never heard of by its id", () => {
    const detail = describeUnavailableProviderInstance({
      requested: { instanceId: ProviderInstanceId.make("codex_personal") },
      offered: [{ instanceId: ProviderInstanceId.make("claudeAgent"), driver: claude }],
    });
    expect(detail).toBe("Codex Personal is not available in this environment. Use Claude instead.");
  });

  it("says so when nothing else is enabled", () => {
    const detail = describeUnavailableProviderInstance({
      requested: { instanceId: ProviderInstanceId.make("codex"), driver: codex },
      offered: [],
    });
    expect(detail).toBe(
      "Codex is not available in this environment, and no other agent is enabled. Enable one in Settings to continue.",
    );
  });
});

describe("providerFailureDetail", () => {
  it("shows only the sentence of a validation failure, never its stack", () => {
    const issue = describeUnavailableProviderInstance({
      requested: { instanceId: ProviderInstanceId.make("codex"), driver: codex },
      offered: [{ instanceId: ProviderInstanceId.make("claudeAgent"), driver: claude }],
    });
    const cause = Cause.fail(
      new ProviderValidationError({ operation: "ProviderService.startSession", issue }),
    );

    const detail = providerFailureDetail(cause);

    expect(detail).toBe("Codex is not available in this environment. Use Claude instead.");
    expect(looksLikeAStack(detail)).toBe(false);
    // The operator's view keeps the stack the person never sees.
    expect(Cause.pretty(cause)).toContain("ProviderService.startSession");
  });

  it("keeps an unrelated provider error's own message instead of a generic one", () => {
    expect(
      providerFailureDetail(
        Cause.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/start",
            detail: "Rate limit reached. Try again in 20 minutes.",
          }),
        ),
      ),
    ).toBe("Rate limit reached. Try again in 20 minutes.");
    expect(
      providerFailureDetail(
        Cause.fail(new ProviderWorkspaceMissingError({ threadId: "thread-1", cwd: "/gone" })),
      ),
    ).toBe(
      "This thread's workspace folder no longer exists or is not a directory: /gone. Restore the folder at this path before retrying.",
    );
    expect(
      providerFailureDetail(Cause.fail(new ProviderSessionNotFoundError({ threadId: "thread-1" }))),
    ).toBe("Unknown provider thread: thread-1");
  });

  it("shows a defect's message without its frames", () => {
    const detail = providerFailureDetail(Cause.die(new Error("codex exited with code 137")));
    expect(detail).toBe("codex exited with code 137");
    expect(looksLikeAStack(detail)).toBe(false);
  });
});
