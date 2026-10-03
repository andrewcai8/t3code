import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "../connection/model.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import {
  createEnvironmentPresentationAtoms,
  createEnvironmentSummaryAtoms,
} from "./presentation.ts";

const HOST = EnvironmentId.make("host");
const BOX = EnvironmentId.make("box");

describe("a connected cloud box", () => {
  it("is in the connected list mobile's outbox, uploads and new task draft read, though not a user environment", () => {
    const catalog = Atom.make<EnvironmentCatalogState>({
      isReady: true,
      entries: new Map([
        [
          HOST,
          {
            target: new PrimaryConnectionTarget({
              environmentId: HOST,
              label: "Host",
              httpBaseUrl: "https://host.example.test",
              wsBaseUrl: "wss://host.example.test",
            }),
            enabled: true,
            profile: Option.none(),
          },
        ],
        [
          BOX,
          {
            target: new BearerConnectionTarget({
              environmentId: BOX,
              label: "e2b.local",
              connectionId: "box-connection",
              box: { managerId: HOST },
            }),
            enabled: true,
            profile: Option.none(),
          },
        ],
      ]),
    });
    const connected = Atom.make(
      AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, phase: "connected", generation: 1 }),
    );
    const full = createEnvironmentPresentationAtoms({
      catalogValueAtom: catalog,
      stateAtom: () => connected,
      serverConfigValueAtom: Atom.family((_id: EnvironmentId) =>
        Atom.make<ServerConfig | null>(null),
      ),
    });
    const summaries = createEnvironmentSummaryAtoms({
      catalogValueAtom: catalog,
      presentationAtom: full.presentationAtom,
    });
    const registry = AtomRegistry.make();
    try {
      expect(
        registry
          .get(summaries.environmentsAtom)
          .map(({ environmentId, connectionState }) => [environmentId, connectionState]),
      ).toEqual([
        [HOST, "connected"],
        [BOX, "connected"],
      ]);
      expect([...registry.get(full.presentationsAtom).keys()]).toEqual([HOST]);
    } finally {
      registry.dispose();
    }
  });
});
