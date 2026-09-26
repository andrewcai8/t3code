import { describe, expect, it } from "@effect/vitest";

import {
  CODEX_LOGIN_COPY_MIN_LIFETIME_MS,
  CODEX_LOGIN_REFRESH_AHEAD_MS,
  codexLoginExpiredMessage,
  codexLoginExpiring,
  codexLoginRefreshDue,
  codexLoginSignedOut,
  parseCodexLogin,
  stripCodexRefreshToken,
} from "./codexLoginCopy.ts";

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

    expect(JSON.parse(stripCodexRefreshToken(login) ?? "")).toEqual({
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

  it("returns a login with no refresh token unchanged, and nothing for a torn file", () => {
    expect([
      stripCodexRefreshToken('{"OPENAI_API_KEY":"sk-proj-key"}'),
      stripCodexRefreshToken('{"tokens":{"id_token":"eyJ.id.sig","refresh_tok'),
    ]).toEqual(['{"OPENAI_API_KEY":"sk-proj-key"}', undefined]);
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
      parseCodexLogin(stripCodexRefreshToken(login('{"exp":1790600400,"sub":"user-1"}'))!),
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

describe("codexLoginRefreshDue", () => {
  const now = Date.parse("2026-09-28T14:00:00Z");
  it.each([
    {
      login: "expires in 49 hours",
      authJson: login('{"exp":1790780400}'),
      ahead: false,
      copy: false,
    },
    {
      login: "expires in 47 hours",
      authJson: login('{"exp":1790773200}'),
      ahead: true,
      copy: false,
    },
    {
      login: "expires in 20 hours",
      authJson: login('{"exp":1790676000}'),
      ahead: true,
      copy: true,
    },
    {
      login: "expired an hour ago",
      authJson: login('{"exp":1790600400}'),
      ahead: true,
      copy: true,
    },
    {
      login: "is a copy expiring in 20 hours",
      authJson: stripCodexRefreshToken(login('{"exp":1790676000}'))!,
      ahead: false,
      copy: false,
    },
    {
      login: "has no readable expiry",
      authJson: login('{"sub":"user-1"}'),
      ahead: false,
      copy: false,
    },
  ])(
    "on a host, a login that $login refreshes ahead: $ahead, before a copy: $copy",
    ({ authJson, ahead, copy }) => {
      const parsed = parseCodexLogin(authJson);
      const host = { now, localAgentRuns: false };
      expect([
        codexLoginRefreshDue(parsed, CODEX_LOGIN_REFRESH_AHEAD_MS, host),
        codexLoginRefreshDue(parsed, CODEX_LOGIN_COPY_MIN_LIFETIME_MS, host),
      ]).toEqual([ahead, copy]);
    },
  );

  it("never refreshes ahead on a server that runs agents, where Codex keeps its own schedule", () => {
    const expired = parseCodexLogin(login('{"exp":1790600400}'));
    expect([
      codexLoginRefreshDue(expired, CODEX_LOGIN_REFRESH_AHEAD_MS, { now, localAgentRuns: true }),
      codexLoginRefreshDue(expired, CODEX_LOGIN_REFRESH_AHEAD_MS, { now, localAgentRuns: false }),
    ]).toEqual([false, true]);
  });
});

describe("codexLoginSignedOut", () => {
  const now = Date.parse("2026-09-28T14:00:00Z");
  const copy = (payload: string) => stripCodexRefreshToken(login(payload))!;
  it.each([
    {
      login: "a copy with 20 minutes left",
      authJson: copy('{"exp":1790605200}'),
      onHost: true,
      elsewhere: true,
    },
    {
      login: "a copy with 2 hours left",
      authJson: copy('{"exp":1790611200}'),
      onHost: false,
      elsewhere: false,
    },
    {
      login: "an own login past expiry",
      authJson: login('{"exp":1790600400}'),
      onHost: true,
      elsewhere: false,
    },
    {
      login: "an own login with 20 minutes left",
      authJson: login('{"exp":1790605200}'),
      onHost: false,
      elsewhere: false,
    },
  ])(
    "$login is signed out on a host: $onHost, elsewhere: $elsewhere",
    ({ authJson, onHost, elsewhere }) => {
      const parsed = parseCodexLogin(authJson);
      expect([
        codexLoginSignedOut(parsed, { now, localAgentRuns: false }),
        codexLoginSignedOut(parsed, { now, localAgentRuns: true }),
      ]).toEqual([onHost, elsewhere]);
    },
  );

  it("tells a host to sign its own login in again, and a copy to be reseeded", () => {
    const own = parseCodexLogin(login('{"exp":1790600400}'));
    const copied = parseCodexLogin(copy('{"exp":1790600400}'));
    expect([
      codexLoginExpiredMessage("codex_uci", own, { localAgentRuns: false }),
      codexLoginExpiredMessage("codex_uci", copied, { localAgentRuns: false }),
      codexLoginExpiredMessage("codex_uci", own, { localAgentRuns: true }),
    ]).toEqual([
      "codex_uci's Codex login on this host expired; sign in again with ~/.t3/provisioning/codex-site-login.sh and reseed.",
      "codex_uci's Codex login expired; sign in on your computer and reseed.",
      "codex_uci's Codex login expired; sign in on your computer and reseed.",
    ]);
  });
});
