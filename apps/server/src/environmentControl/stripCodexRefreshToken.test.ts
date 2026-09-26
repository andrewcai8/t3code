import { describe, expect, it } from "@effect/vitest";

import { stripCodexRefreshToken } from "./stripCodexRefreshToken.ts";

describe("stripCodexRefreshToken", () => {
  it("replaces only the refresh token of a ChatGPT login", () => {
    const login = `{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "eyJ.id.sig",
    "access_token": "eyJ.access.sig",
    "refresh_token": "rt_live-refresh-token",
    "account_id": "acct-1"
  },
  "last_refresh": "2026-09-18T14:34:00.000000Z"
}`;

    expect(JSON.parse(stripCodexRefreshToken(login))).toEqual({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "eyJ.id.sig",
        access_token: "eyJ.access.sig",
        refresh_token: "t3-copy-cannot-refresh",
        account_id: "acct-1",
      },
      last_refresh: "2026-09-18T14:34:00.000000Z",
    });
  });

  it("returns a login with no refresh token, or text Codex cannot load, unchanged", () => {
    expect(stripCodexRefreshToken('{"OPENAI_API_KEY":"sk-proj-key"}')).toBe(
      '{"OPENAI_API_KEY":"sk-proj-key"}',
    );
    expect(stripCodexRefreshToken("not json")).toBe("not json");
  });
});
