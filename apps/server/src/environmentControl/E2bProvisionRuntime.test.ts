// @effect-diagnostics nodeBuiltinImport:off - uploads are exercised against a real local HTTP server.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { CommandExitError } from "e2b";
import { describe, expect, it } from "vite-plus/test";

import { e2bPythonResult, uploadFile } from "./E2bProvisionRuntime.ts";

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
