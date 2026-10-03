import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as TokenStore from "../authorization/tokenStore.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BoxTargetRegistration,
} from "../connection/catalog.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
} from "./storageDocument.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const decodeBoxTargetRegistration = Schema.decodeUnknownSync(BoxTargetRegistration);
const encodeBearerTarget = Schema.encodeSync(BearerConnectionTarget);

const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-1",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});
const REMOTE_TOKEN = new TokenStore.RemoteDpopAccessToken({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  endpoint: {
    httpBaseUrl: "https://remote.example.test",
    wsBaseUrl: "wss://remote.example.test",
    providerKind: "cloudflare_tunnel",
  },
  accessToken: "dpop-token",
  expiresAtEpochMs: 1_000_000,
  dpopThumbprint: "thumbprint",
});

describe("ConnectionCatalogDocument cloud boxes", () => {
  it("retains missing workspace status and credentials through catalog reload", () => {
    const original = registerConnectionInCatalog(
      { ...EMPTY_CONNECTION_CATALOG_DOCUMENT, remoteDpopTokens: [REMOTE_TOKEN] },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const missing = registerConnectionInCatalog(
      original,
      new BearerConnectionRegistration({
        target: new BearerConnectionTarget({ ...BEARER_TARGET, workspaceStatus: "missing" }),
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const schema = Schema.fromJsonString(ConnectionCatalogDocument);
    const reloaded = Schema.decodeSync(schema)(Schema.encodeSync(schema)(missing));

    expect(reloaded.targets).toEqual([
      new BearerConnectionTarget({ ...BEARER_TARGET, workspaceStatus: "missing" }),
    ]);
    expect(reloaded.profiles).toEqual(original.profiles);
    expect(reloaded.credentials).toEqual(original.credentials);
    expect(reloaded.remoteDpopTokens).toEqual(original.remoteDpopTokens);
  });

  it("saves a box its host listed without a credential, and relabeling it keeps its pairing", () => {
    const box = new BearerConnectionTarget({
      ...BEARER_TARGET,
      label: "t3code · E2B",
      box: { managerId: EnvironmentId.make("host") },
    });
    const listed = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BoxTargetRegistration({ target: box }),
    );
    expect([listed.targets, listed.profiles, listed.credentials]).toEqual([[box], [], []]);

    const paired = registerConnectionInCatalog(
      listed,
      new BearerConnectionRegistration({
        target: box,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const relabeled = registerConnectionInCatalog(
      paired,
      new BoxTargetRegistration({
        target: new BearerConnectionTarget({ ...box, label: "app · E2B" }),
      }),
    );
    expect(relabeled.targets.map((target) => target.label)).toEqual(["app · E2B"]);
    expect(relabeled.profiles).toEqual([BEARER_PROFILE]);
    expect(relabeled.credentials).toEqual([
      { connectionId: BEARER_TARGET.connectionId, credential: BEARER_CREDENTIAL },
    ]);
  });

  it("refuses to save a target without a credential unless it is a box", () => {
    const encoded = { ...encodeBearerTarget(BEARER_TARGET) };
    expect(() =>
      decodeBoxTargetRegistration({ _tag: "BoxTargetRegistration", target: encoded }),
    ).toThrow("A box target names its host.");
    expect(
      decodeBoxTargetRegistration({
        _tag: "BoxTargetRegistration",
        target: { ...encoded, box: { managerId: "host" } },
      }).target.box,
    ).toEqual({ managerId: "host" });
  });
});
