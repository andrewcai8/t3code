type StreamWrite = (...args: readonly never[]) => boolean;

interface GuardableStream {
  write: StreamWrite;
  readonly on: (event: "error", listener: () => void) => unknown;
}

/**
 * Stop a failed write on this process's stderr from killing the process. The desktop app runs the
 * server with piped stdio, so stderr can fail with `EIO`, and Node prints warnings through
 * `console.error` with no error handling, making any warning fatal. A swallowed write reports
 * success so callers do not wait on a `drain` event that never arrives.
 */
export const guardStderr = (stream: GuardableStream): void => {
  const write = stream.write.bind(stream);
  stream.write = (...args) => {
    try {
      return write(...args);
    } catch {
      return true;
    }
  };
  stream.on("error", () => {});
};
