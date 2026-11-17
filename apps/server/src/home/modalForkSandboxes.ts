import type { ModalCopySpec } from "../environmentControl/ModalRuntime.ts";
import { makeModalBoxes } from "../environmentControl/ModalRuntime.ts";
import type { ForkSandboxes, ModalPlatform, SandboxSize } from "./worktreeForksConfig.ts";

/**
 * A sandbox booted from `imageId`, on the vm runtime, which ran a megpt-mono test shard in half
 * the time gVisor took. Egress stays open, like the host it stands in for.
 */
export const copySpec = (
  platform: ModalPlatform,
  input: {
    readonly imageId: string;
    readonly size: SandboxSize;
    readonly lifetimeMs: number;
    readonly tags: Readonly<Record<string, string>>;
  },
): ModalCopySpec => ({
  app: platform.app,
  ...(platform.environment === undefined ? {} : { environment: platform.environment }),
  imageId: input.imageId,
  runtime: "vm",
  timeoutMs: input.lifetimeMs,
  sizing: {
    cpu: input.size.cpuRequest,
    cpuLimit: input.size.cpu,
    memoryMiB: input.size.memoryRequestMiB,
    memoryLimitMiB: input.size.memoryMiB,
  },
  tags: input.tags,
  egress: { domains: [], cidrs: [] },
});

export const makeModalForkSandboxes = (platform: ModalPlatform): ForkSandboxes => {
  const boxes = makeModalBoxes(platform);
  return {
    createCopy: (input) => boxes.createCopy(copySpec(platform, input)),
    exec: boxes.exec,
    execStream: boxes.execStream,
    upload: boxes.upload,
    download: boxes.download,
    saveDisk: boxes.saveDisk,
    deleteImage: boxes.deleteImage,
    // Modal deletes a base and an upload image at their own ttl.
    pruneImages: async () => undefined,
    terminate: boxes.terminate,
    list: (tags) => boxes.list(platform.app, platform.environment, tags),
    directoryImages: { save: boxes.saveDirectory, mount: boxes.mountImage },
  };
};
