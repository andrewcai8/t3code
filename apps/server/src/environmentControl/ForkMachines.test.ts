import { expect, it } from "@effect/vitest";

import { captureBatch } from "./ForkMachines.ts";

it("reads the batch from a capture's snapshot name, with or without its team and tag", () => {
  const batch = "7880e39f-43ec-496e-b333-f616a22862bf";
  expect(
    [
      `acme/t3-worker-fork-host-a-${batch}:default`,
      `acme/t3-worker-fork-host-a-${batch}`,
      `t3-worker-fork-host-a-${batch}:v2`,
      `acme/t3-worker-fork-host-b-${batch}:default`,
      "acme/t3-natural-recovery-20260913-2022:default",
    ].map((name) => captureBatch("Host A", name)),
  ).toEqual([batch, batch, batch, null, null]);
});
