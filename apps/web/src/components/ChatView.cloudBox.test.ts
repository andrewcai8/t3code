import { newChatProject } from "@t3tools/client-runtime/cloud";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isDraftOnAnotherChatsBox, projectEnvironmentOptions } from "./ChatView.logic";

const HOST = EnvironmentId.make("andrew-megpt-host");
const BOX = EnvironmentId.make("e2b-box");
const hostProject = {
  environmentId: HOST,
  id: ProjectId.make("megpt-mono-host"),
  key: "megpt-mono",
};
const boxProject = { environmentId: BOX, id: ProjectId.make("megpt-mono-box"), key: "megpt-mono" };
const projects = [boxProject, hostProject];
const host = { label: "andrew.megpt.app", serverConfig: null };
const box = { label: "e2b.local", serverConfig: null };

/**
 * The reported state: a new chat's draft for megpt-mono whose project is the copy on `e2b.local`,
 * a cloud box saved before boxes were marked, now marked by the migration.
 */
describe("a draft on the megpt-mono copy of a legacy e2b.local box", () => {
  const draft = {
    draftId: "c3bea36c",
    environmentId: BOX,
    ownBoxEnvironmentId: null,
    boxIds: new Set([BOX]),
  };

  it("is not the box's, so it moves to the host's copy of the project", () => {
    expect(isDraftOnAnotherChatsBox(draft)).toBe(true);
    const moveTo = newChatProject({
      requested: { environmentId: BOX, projectId: boxProject.id },
      projects,
      logicalProjectKey: (project) => project.key,
      environmentState: (environmentId) => (environmentId === HOST ? { serverConfig: null } : null),
    });
    expect(moveTo).toEqual(hostProject);
  });

  it("never offers the box in Run on", () => {
    // The user environments; the box is not one, and it is not the draft's own.
    const options = projectEnvironmentOptions({
      projects,
      environmentById: new Map([[HOST, host]]),
      primaryEnvironmentId: HOST,
    });
    expect(options).toEqual([
      {
        environmentId: HOST,
        projectId: hostProject.id,
        label: "andrew.megpt.app",
        isPrimary: true,
        machine: "server",
      },
    ]);
  });
});

describe("a draft on the box its own cloud send started", () => {
  it("keeps the box, which Run on names", () => {
    expect(
      isDraftOnAnotherChatsBox({
        draftId: "c3bea36c",
        environmentId: BOX,
        ownBoxEnvironmentId: BOX,
        boxIds: new Set([BOX]),
      }),
    ).toBe(false);
    const options = projectEnvironmentOptions({
      projects,
      environmentById: new Map([
        [HOST, host],
        [BOX, box],
      ]),
      primaryEnvironmentId: HOST,
    });
    expect(options.map(({ label }) => label)).toEqual(["andrew.megpt.app", "e2b.local"]);
  });
});
