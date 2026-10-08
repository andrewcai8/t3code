// @effect-diagnostics nodeBuiltinImport:off - uploads are exercised against a real local HTTP server.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { CommandExitError } from "e2b";
import { describe, expect, it } from "vite-plus/test";

import {
  e2bPythonResult,
  guardMemoryCommand,
  protectEnvdCommand,
  uploadFile,
  warmSealHomePaths,
} from "./E2bProvisionRuntime.ts";

describe("e2bPythonResult", () => {
  it("returns a successful command as python stdout/stderr", async () => {
    await expect(
      e2bPythonResult(Promise.resolve({ exitCode: 0, stdout: '{"ok":true}', stderr: "" })),
    ).resolves.toEqual({ exitCode: 0, stdout: '{"ok":true}', stderr: "" });
  });

  it("unwraps CommandExitError so python stderr reaches prepareRemoteHost", async () => {
    await expect(
      e2bPythonResult(
        Promise.reject(
          new CommandExitError({
            exitCode: 1,
            stdout: "",
            stderr: "Remote preparation failed: Preparation command timed out: git fetch",
          }),
        ),
      ),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Remote preparation failed: Preparation command timed out: git fetch",
    });
  });

  it("rethrows transport failures that are not a command exit", async () => {
    await expect(e2bPythonResult(Promise.reject(new Error("sandbox gone")))).rejects.toThrow(
      "sandbox gone",
    );
  });
});

describe("uploadFile", () => {
  async function upload(
    contents: string | Buffer,
    handle: (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void,
  ) {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "e2b-upload-"));
    const path = NodePath.join(root, "runtime.tar");
    await NodeFSP.writeFile(path, contents);
    const server = NodeHttp.createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      return await uploadFile(
        `http://127.0.0.1:${port}/files?path=%2Ftmp%2Fruntime.tar`,
        path,
        Buffer.byteLength(contents),
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }

  it("streams the file as an octet-stream body", async () => {
    const received: Array<unknown> = [];
    await upload("runtime archive bytes", async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      received.push(request.url, request.headers["content-type"], body);
      response.end("[]");
    });
    expect(received).toEqual([
      "/files?path=%2Ftmp%2Fruntime.tar",
      "application/octet-stream",
      "runtime archive bytes",
    ]);
  });

  it("names the status when envd refuses the upload", async () => {
    await expect(
      upload("runtime archive bytes", async (request, response) => {
        for await (const _ of request);
        response.writeHead(500).end("disk full");
      }),
    ).rejects.toThrow("The runtime artifact upload failed (500): disk full");
  });

  it("names the status when envd answers before it reads the body", async () => {
    await expect(
      upload(Buffer.alloc(64 * 1024 * 1024), (_request, response) => {
        response.writeHead(401).end("bad signature");
      }),
    ).rejects.toThrow("The runtime artifact upload failed (401): bad signature");
  });
});

describe("warmSealHomePaths", () => {
  it("names every login, the GitHub token files, and Claude's account record", () => {
    const paths = warmSealHomePaths();
    expect(
      [
        ".codex/auth.json",
        ".config/cursor/auth.json",
        ".cursor/auth.json",
        ".claude/.credentials.json",
        ".claude.json",
        ".git-credentials",
        ".gitconfig",
        ".config/gh/hosts.yml",
      ].filter((path) => !paths.includes(path)),
    ).toEqual([]);
  });
});

describe("protectEnvdCommand", () => {
  it("writes E2B's envd drop-in and reloads systemd only when the file differs", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "envd-protect-"));
    const bin = NodePath.join(root, "bin");
    const reloads = NodePath.join(root, "systemctl.log");
    await NodeFSP.mkdir(bin);
    await NodeFSP.writeFile(
      NodePath.join(bin, "sudo"),
      '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n',
      { mode: 0o755 },
    );
    await NodeFSP.writeFile(
      NodePath.join(bin, "systemctl"),
      `#!/bin/sh\necho "$@" >> '${reloads}'\n`,
      { mode: 0o755 },
    );
    const directory = NodePath.join(root, "system.slice.d");
    const dropIn = NodePath.join(directory, "10-e2b-envd.conf");
    const run = () =>
      NodeChildProcess.execFileSync("sh", ["-c", protectEnvdCommand(directory)], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
    try {
      run();
      run();
      expect(await NodeFSP.readFile(dropIn, "utf8")).toBe(
        "[Slice]\nMemoryMin=128M\nMemoryLow=256M\n",
      );
      expect(await NodeFSP.readFile(reloads, "utf8")).toBe("daemon-reload\n");

      await NodeFSP.writeFile(dropIn, "[Slice]\nMemoryMin=0\n");
      run();
      expect(await NodeFSP.readFile(dropIn, "utf8")).toBe(
        "[Slice]\nMemoryMin=128M\nMemoryLow=256M\n",
      );
      expect(await NodeFSP.readFile(reloads, "utf8")).toBe("daemon-reload\ndaemon-reload\n");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe("guardMemoryCommand", () => {
  it("installs and starts earlyoom once, and leaves a running one with these settings alone", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "earlyoom-guard-"));
    const bin = NodePath.join(root, "bin");
    const calls = NodePath.join(root, "calls.log");
    const active = NodePath.join(root, "active");
    const script = (body: string) => `#!/bin/sh\n${body}\n`;
    await NodeFSP.mkdir(bin);
    const tools: Record<string, string> = {
      sudo: script('[ "$1" = -n ] && shift\nexec "$@"'),
      // Runs the unit's command in place of systemd's transient service.
      "systemd-run": script(
        `printf '%s\\n' "systemd-run $*" >> '${calls}'\nwhile [ "$1" != sh ]; do shift; done\nexec "$@"`,
      ),
      "apt-get": script(
        `echo "apt-get $*" >> '${calls}'\nprintf '#!/bin/sh\\n' > '${bin}/earlyoom'\nchmod +x '${bin}/earlyoom'`,
      ),
      systemctl: script(
        `echo "systemctl $*" >> '${calls}'\ncase "$1" in\n  restart) touch '${active}' ;;\n  is-active) [ -f '${active}' ] ;;\nesac`,
      ),
    };
    for (const [name, body] of Object.entries(tools))
      await NodeFSP.writeFile(NodePath.join(bin, name), body, { mode: 0o755 });
    const defaults = NodePath.join(root, "earlyoom");
    const run = () =>
      NodeChildProcess.execFileSync("sh", ["-c", guardMemoryCommand(defaults)], {
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      });
    const callLog = async () =>
      (await NodeFSP.readFile(calls, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ").slice(0, 2).join(" "));
    try {
      run();
      expect(await callLog()).toEqual([
        "systemd-run --quiet",
        "apt-get install",
        "systemctl enable",
        "systemctl restart",
      ]);
      expect(await NodeFSP.readFile(defaults, "utf8")).toBe(
        'EARLYOOM_ARGS="-m 8 -s 100 -r 0 --avoid (^|/)(envd|systemd|sshd|claude|codex|node)$ --prefer (^|/)(bun|python3|vitest|tsc|esbuild)$"\n',
      );

      await NodeFSP.writeFile(calls, "");
      run();
      expect(await callLog()).toEqual(["systemctl is-active"]);

      await NodeFSP.writeFile(defaults, 'EARLYOOM_ARGS="-m 2"\n');
      await NodeFSP.writeFile(calls, "");
      run();
      expect(await callLog()).toEqual([
        "systemd-run --quiet",
        "systemctl enable",
        "systemctl restart",
      ]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
