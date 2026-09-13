// @effect-diagnostics nodeBuiltinImport:off - the SDK requires a synchronous SpawnedProcess with Node streams and process events.
import * as NodeChildProcess from "node:child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { workloadCommand } from "@t3tools/shared/workload";

export function spawnClaudeWorkload(options: SpawnOptions): SpawnedProcess {
  const command = workloadCommand(options.command, options.args);
  return NodeChildProcess.spawn(command.command, command.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "inherit"],
  });
}
