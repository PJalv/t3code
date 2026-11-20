// @effect-diagnostics nodeBuiltinImport:off -- These forked Node workers do not run an Effect runtime.
import type * as NodeChildProcess from "node:child_process";

type WorkerProcess = {
  readonly connected?: boolean;
  readonly send?: (
    message: NodeChildProcess.Serializable,
    callback: (error: Error | null) => void,
  ) => boolean;
  readonly exit: (code: number) => void;
};

function isClosedChannelError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EPIPE" ||
      error.code === "ECONNRESET" ||
      error.code === "ERR_IPC_CHANNEL_CLOSED")
  );
}

// A parent timeout can close IPC while native capture is still running.
// A callback handles asynchronous send errors without hiding unrelated failures.
export function sendWorkerMessage(
  message: NodeChildProcess.Serializable,
  worker: WorkerProcess = process,
): void {
  if (!worker.send || !worker.connected) {
    worker.exit(0);
    return;
  }
  const handleError = (error: unknown) => {
    if (isClosedChannelError(error)) {
      worker.exit(0);
      return;
    }
    throw error;
  };
  try {
    worker.send(message, (error) => {
      if (error) handleError(error);
    });
  } catch (error) {
    handleError(error);
  }
}
