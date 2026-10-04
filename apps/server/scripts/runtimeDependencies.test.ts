import { assert, it } from "@effect/vitest";

import { findUntestedPackages, resolveRuntimeDependencies } from "./runtimeDependencies.ts";

const lock = {
  importers: {
    "apps/server": {
      dependencies: {
        "@anthropic-ai/claude-agent-sdk": { version: "0.3.276" },
        "@bufbuild/protobuf": { version: "2.16.0" },
        "@cursor/sdk": { version: "1.0.31" },
        "node-pty": { version: "1.2.0-beta.15(patch_hash=f2fe)" },
      },
    },
  },
  snapshots: {
    "@bufbuild/protobuf@2.16.0": {},
    "@bufbuild/protobuf@1.10.0": {},
    "@cursor/sdk@1.0.31": {
      dependencies: { "@bufbuild/protobuf": "1.10.0", zod: "3.25.76" },
      optionalDependencies: { "@cursor/sdk-linux-x64": "1.0.31" },
    },
    "@cursor/sdk-linux-x64@1.0.31": {},
    "node-addon-api@7.1.1": {},
    "node-pty@1.2.0-beta.15(patch_hash=f2fe)": { dependencies: { "node-addon-api": "7.1.1" } },
    "zod@3.25.76": {},
  },
};

it("installs only the bundle's externals, each pinned to what pnpm resolved", () => {
  const { dependencies, overrides } = resolveRuntimeDependencies(lock, "apps/server");

  assert.deepStrictEqual(dependencies, {
    "@bufbuild/protobuf": "2.16.0",
    "@cursor/sdk": "1.0.31",
    "node-pty": "1.2.0-beta.15",
  });
  assert.deepStrictEqual(overrides, {
    zod: "3.25.76",
    "@cursor/sdk-linux-x64": "1.0.31",
    "node-addon-api": "7.1.1",
  });
});

it("reports npm resolutions pnpm never tested, at any depth", () => {
  const { versions } = resolveRuntimeDependencies(lock, "apps/server");

  const untested = findUntestedPackages(
    {
      packages: {
        "": {},
        "node_modules/@bufbuild/protobuf": { version: "2.16.0" },
        "node_modules/@cursor/sdk": { version: "1.0.31" },
        "node_modules/@cursor/sdk/node_modules/@bufbuild/protobuf": { version: "1.11.0" },
        "node_modules/zod": { version: "3.25.76" },
        "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64": { version: "0.3.288" },
      },
    },
    versions,
  );

  assert.deepStrictEqual(untested, [
    "@bufbuild/protobuf@1.11.0",
    "@anthropic-ai/claude-agent-sdk-linux-x64@0.3.288",
  ]);
});

it("fails when pnpm-lock.yaml is missing a package in the closure", () => {
  assert.throws(
    () =>
      resolveRuntimeDependencies(
        {
          ...lock,
          snapshots: Object.fromEntries(
            Object.entries(lock.snapshots).filter(([key]) => key !== "zod@3.25.76"),
          ),
        },
        "apps/server",
      ),
    /no snapshot for zod@3.25.76/,
  );
});
