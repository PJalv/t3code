import {
  readAccessibleWindowContextWithApp,
  type SnapShotAccessibilityRequest,
} from "./SnapShotAccessibility.ts";
import { sendWorkerMessage } from "./WorkerIpc.ts";

process.once("disconnect", () => process.exit(0));

async function readAccessibility() {
  const { App } = await import("@crowecawcaw/xa11y");
  sendWorkerMessage("ready");
  const request = await new Promise<SnapShotAccessibilityRequest>((resolve) => {
    process.once("message", resolve);
  });
  let started = false;
  const markStarted = () => {
    if (started) return;
    started = true;
    sendWorkerMessage("started");
  };
  const context = await readAccessibleWindowContextWithApp(App, request, markStarted).catch(
    () => undefined,
  );
  markStarted();
  sendWorkerMessage({ type: "result", context });
}

if (process.argv[2] === "read") {
  void readAccessibility().catch(() => sendWorkerMessage({ type: "result" }));
}
