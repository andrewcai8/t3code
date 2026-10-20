// @effect-diagnostics nodeBuiltinImport:off - downloads land in real files, as Modal's do.
/**
 * An in-memory stand-in for the Modal members WorktreeForks uses. Sandboxes are ids with tags;
 * execs answer from scripted rules, so tests can hold a step open or fail it.
 *
 * @module worktreeForksTestkit
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ForkSandboxes } from "./worktreeForksConfig.ts";

export type FakeExecReply =
  | {
      readonly exitCode: number;
      readonly stdout?: string;
      readonly chunks?: ReadonlyArray<readonly ["stdout" | "stderr", string]>;
    }
  /** Streams `chunks`, then answers when the test settles `exitCode`. */
  | {
      readonly chunks?: ReadonlyArray<readonly ["stdout" | "stderr", string]>;
      readonly exitCode: Promise<number>;
    }
  /** Runs the step for real on this machine; `uploaded` maps a sandbox path to its local copy. */
  | {
      readonly run: (argv: ReadonlyArray<string>, uploaded: ReadonlyMap<string, string>) => number;
    };

export interface FakeCall {
  readonly op: string;
  readonly sandboxId?: string;
  readonly argv?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly workdir?: string;
  readonly imageId?: string;
  readonly cpu?: number;
  readonly tags?: Readonly<Record<string, string>>;
}

/** A Promise the test settles, and one that settles once the code under test reaches it. */
export const gate = <A>() => {
  let open!: (value: A) => void;
  let reach!: () => void;
  const value = new Promise<A>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return { value, open, reached, reach };
};

export const makeFakeSandboxes = () => {
  const calls: Array<FakeCall> = [];
  const sandboxes = new Map<string, { readonly tags: Readonly<Record<string, string>> }>();
  const images = new Set<string>();
  const rules: Array<{
    readonly match: (argv: ReadonlyArray<string>) => boolean;
    readonly reply: FakeExecReply;
  }> = [];
  const failures = new Map<string, Error>();
  const holds = new Map<string, ReturnType<typeof gate<void>>>();
  const waiters: Array<{ readonly op: string; readonly resolve: (call: FakeCall) => void }> = [];
  const record = (call: FakeCall) => {
    calls.push(call);
    for (const waiter of waiters.filter((candidate) => candidate.op === call.op)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(call);
    }
  };
  let next = 0;
  let downloadSource: string | null = null;

  const step = async (op: string) => {
    const failure = failures.get(op);
    if (failure !== undefined) {
      failures.delete(op);
      throw failure;
    }
    const hold = holds.get(op);
    if (hold !== undefined) {
      holds.delete(op);
      hold.reach();
      await hold.value;
    }
  };
  const uploads = new Map<string, string>();
  const replyTo = (argv: ReadonlyArray<string>) => {
    const reply = rules.find((rule) => rule.match(argv))?.reply ?? { exitCode: 0 };
    return "run" in reply ? { exitCode: reply.run(argv, uploads) } : reply;
  };

  const port: ForkSandboxes = {
    createCopy: async (spec) => {
      record({ op: "create", imageId: spec.imageId, cpu: spec.sizing.cpu, tags: spec.tags });
      await step("create");
      const sandboxId = `sb-${++next}`;
      sandboxes.set(sandboxId, { tags: spec.tags });
      return sandboxId;
    },
    exec: async (sandboxId, argv, options) => {
      record({ op: "exec", sandboxId, argv, ...options });
      const reply = replyTo(argv);
      const text = (stream: "stdout" | "stderr") =>
        (reply.chunks ?? [])
          .filter(([from]) => from === stream)
          .map(([, chunk]) => chunk)
          .join("");
      return {
        exitCode: await reply.exitCode,
        stdout: ("stdout" in reply ? (reply.stdout ?? "") : "") + text("stdout"),
        stderr: text("stderr"),
      };
    },
    execStream: async (sandboxId, argv, { onOutput, ...options }) => {
      record({ op: "stream", sandboxId, argv, ...options });
      await step("stream");
      const reply = replyTo(argv);
      for (const [stream, text] of reply.chunks ?? []) onOutput(stream, text);
      return reply.exitCode;
    },
    upload: async (sandboxId, localPath, remotePath) => {
      record({ op: "upload", sandboxId, argv: [remotePath] });
      await step("upload");
      const copy = `${NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3wf-upload-"))}/file`;
      NodeFS.copyFileSync(localPath, copy);
      uploads.set(remotePath, copy);
    },
    download: async (sandboxId, _remotePath, localPath) => {
      record({ op: "download", sandboxId });
      if (downloadSource !== null) NodeFS.copyFileSync(downloadSource, localPath);
    },
    saveDisk: async (sandboxId) => {
      record({ op: "saveDisk", sandboxId });
      await step("saveDisk");
      const imageId = `im-${++next}`;
      images.add(imageId);
      return imageId;
    },
    deleteImage: async (imageId) => {
      record({ op: "deleteImage", imageId });
      images.delete(imageId);
    },
    terminate: async (sandboxId) => {
      record({ op: "terminate", sandboxId });
      sandboxes.delete(sandboxId);
    },
    list: async (_app, _environment, tags) =>
      [...sandboxes]
        .filter(([, sandbox]) =>
          Object.entries(tags).every(([name, value]) => sandbox.tags[name] === value),
        )
        .map(([sandboxId, sandbox]) => ({ sandboxId, tags: { ...sandbox.tags } })),
  };

  return {
    port,
    calls,
    images,
    /** Sandboxes created and not yet terminated. */
    running: () => new Set(sandboxes.keys()),
    /** The first matching rule answers an exec; anything unmatched exits 0. */
    onExec: (match: (argv: ReadonlyArray<string>) => boolean, reply: FakeExecReply) =>
      void rules.unshift({ match, reply }),
    failNext: (op: "create" | "upload" | "saveDisk" | "stream", error: Error) =>
      void failures.set(op, error),
    /** Holds the next call of `op` until the returned gate opens. */
    hold: (op: "create" | "saveDisk" | "stream") => {
      const held = gate<void>();
      holds.set(op, held);
      return held;
    },
    /** Settles at the next call of `op`. */
    next: (op: string) => new Promise<FakeCall>((resolve) => void waiters.push({ op, resolve })),
    /** A sandbox an earlier run left behind. */
    plant: (tags: Readonly<Record<string, string>>) => {
      const sandboxId = `sb-${++next}`;
      sandboxes.set(sandboxId, { tags });
      return sandboxId;
    },
    /** What `download` writes from now on. */
    downloadFrom: (path: string) => void (downloadSource = path),
  };
};

/** Whether an exec runs one of the backend's labelled scripts or a shell command. */
export const isStep = (label: string) => (argv: ReadonlyArray<string>) => argv[3] === label;
export const isCommand = (command: string) => (argv: ReadonlyArray<string>) =>
  argv.at(-3) === "bash" && argv.at(-2) === "-lc" && argv.at(-1) === command;
