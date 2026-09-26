import { describe, expect, it } from "@effect/vitest";

import { codexLoginExpiring, parseCodexLogin, stripCodexRefreshToken } from "./codexLoginCopy.ts";

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

const login = (payload: string, refreshToken = "rt_live") =>
  JSON.stringify({
    tokens: {
      id_token: "eyJ.id.sig",
      access_token: `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(payload).toString("base64url")}.sig`,
      refresh_token: refreshToken,
      account_id: "acct-1",
    },
  });

describe("parseCodexLogin", () => {
  it("reads the access token's expiry and whether the login can refresh", () => {
    expect(parseCodexLogin(login('{"exp":1790600400,"sub":"user-1"}'))).toEqual({
      accessTokenExpiresAt: 1790600400000,
      refreshable: true,
    });
    expect(
      parseCodexLogin(stripCodexRefreshToken(login('{"exp":1790600400,"sub":"user-1"}'))),
    ).toEqual({ accessTokenExpiresAt: 1790600400000, refreshable: false });
    expect(parseCodexLogin(login('{"sub":"user-1"}'))).toEqual({ refreshable: true });
    expect(parseCodexLogin("not json")).toEqual({ refreshable: true });
  });
});

describe("codexLoginExpiring", () => {
  const now = Date.parse("2026-09-28T14:00:00Z");
  it.each([
    { login: "expired an hour ago", authJson: login('{"exp":1790600400}'), expiring: true },
    { login: "expires in 20 minutes", authJson: login('{"exp":1790605200}'), expiring: true },
    { login: "expires in 2 hours", authJson: login('{"exp":1790611200}'), expiring: false },
    { login: "has no readable expiry", authJson: login("not json"), expiring: false },
    { login: "is not JSON", authJson: "not json", expiring: false },
  ])("a login that $login is expiring: $expiring", ({ authJson, expiring }) => {
    expect(codexLoginExpiring(parseCodexLogin(authJson), now)).toBe(expiring);
  });
});
