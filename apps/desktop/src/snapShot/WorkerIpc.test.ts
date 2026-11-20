import { describe, expect, it, vi } from "vite-plus/test";

import { sendWorkerMessage } from "./WorkerIpc.ts";

const closedError = (code: string) => Object.assign(new Error("IPC closed"), { code });

describe("snapshot worker IPC teardown", () => {
  it("exits cleanly when the parent has already disconnected", () => {
    const worker = { connected: false, send: vi.fn(), exit: vi.fn() };
    sendWorkerMessage("ready", worker);
    expect(worker.send).not.toHaveBeenCalled();
    expect(worker.exit).toHaveBeenCalledWith(0);
  });

  it.each(["EPIPE", "ECONNRESET", "ERR_IPC_CHANNEL_CLOSED"])(
    "handles asynchronous %s while a capture result is in flight",
    (code) => {
      const exit = vi.fn();
      let complete: ((error: Error | null) => void) | undefined;
      sendWorkerMessage(
        { type: "result", png: "capture" },
        {
          connected: true,
          send: (_message, callback) => {
            complete = callback;
            return true;
          },
          exit,
        },
      );
      expect(exit).not.toHaveBeenCalled();
      complete?.(closedError(code));
      expect(exit).toHaveBeenCalledWith(0);
    },
  );

  it("handles a synchronous closed-channel error", () => {
    const exit = vi.fn();
    sendWorkerMessage("ready", {
      connected: true,
      send: () => {
        throw closedError("ERR_IPC_CHANNEL_CLOSED");
      },
      exit,
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("does not suppress a serialization or programming error", () => {
    const error = new TypeError("Cannot serialize result");
    const exit = vi.fn();
    expect(() =>
      sendWorkerMessage("ready", {
        connected: true,
        send: () => {
          throw error;
        },
        exit,
      }),
    ).toThrow(error);
    expect(exit).not.toHaveBeenCalled();
  });
});
