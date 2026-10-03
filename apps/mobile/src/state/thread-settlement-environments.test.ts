import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { createThreadListEnvironmentsAtom } from "./thread-list-environments";
import { threadSettlementEnvironmentIds } from "./thread-settlement-environments";

const ID = EnvironmentId.make("one");
const OTHER_ID = EnvironmentId.make("two");
const BOX_ID = EnvironmentId.make("offline-box");
const config = {
  providers: [],
  environment: { capabilities: {}, platform: { machine: "laptop" } },
  settings: {},
} as unknown as ServerConfig;
const settlingConfig = {
  ...config,
  environment: { ...config.environment, capabilities: { threadSettlement: true } },
} as unknown as ServerConfig;

describe("threadSettlementEnvironmentIds", () => {
  it("lets threads on an environment with no loaded config settle", () => {
    const registry = AtomRegistry.make();
    const list = registry.get(
      createThreadListEnvironmentsAtom(
        Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
          new Map([
            [ID, settlingConfig],
            [OTHER_ID, config],
          ]),
        ),
      ),
    );

    const ids = threadSettlementEnvironmentIds(list, [
      { environmentId: ID },
      { environmentId: OTHER_ID },
      { environmentId: BOX_ID },
    ]);

    expect([...ids].toSorted()).toEqual([ID, BOX_ID].toSorted());
    expect(threadSettlementEnvironmentIds(list, [{ environmentId: OTHER_ID }])).toBe(
      list.settlementEnvironmentIds,
    );
  });
});
