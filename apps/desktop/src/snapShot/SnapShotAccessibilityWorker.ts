import {
  readAccessibleWindowContextWithApp,
  type SnapShotAccessibilityRequest,
} from "./SnapShotAccessibility.ts";

process.once("disconnect", () => process.exit(0));

// The parent may tear the IPC channel down at any moment (request timeout,
// shutdown). A send racing that teardown must not crash this worker with an
// unhandled EPIPE — it produces a scary stack trace in the parent's
// inherited stderr for a condition the parent already handles.
const send = (message: unknown): void => {
  try {
    process.send?.(message);
  } catch {
    process.exit(0);
  }
};
process.on("error", () => process.exit(0));

async function readAccessibility() {
  const { App } = await import("@crowecawcaw/xa11y");
  send("ready");
  const request = await new Promise<SnapShotAccessibilityRequest>((resolve) => {
    process.once("message", resolve);
  });
  let started = false;
  const markStarted = () => {
    if (started) return;
    started = true;
    send("started");
  };
  const context = await readAccessibleWindowContextWithApp(App, request, markStarted).catch(
    () => undefined,
  );
  markStarted();
  send({ type: "result", context });
}

if (process.argv[2] === "read") {
  void readAccessibility().catch(() => send({ type: "result", context: undefined }));
}
