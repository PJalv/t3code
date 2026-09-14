// Windows region capture. Runs in a forked Node-mode child so the native
// screenshot call cannot crash or stall the main process. One request per child.
import type { RegionSnapShotRequest, RegionSnapShotResult } from "./RegionSnapShot.ts";

process.once("disconnect", () => process.exit(0));

// The parent may tear the IPC channel down while a send is in flight; an
// unhandled EPIPE here would crash this worker noisily for a condition the
// parent already handles.
const send = (message: unknown): void => {
  try {
    process.send?.(message);
  } catch {
    process.exit(0);
  }
};
process.on("error", () => process.exit(0));

async function capture() {
  const imported = await import("@crowecawcaw/xa11y");
  const xa11y = (imported as unknown as { readonly default?: typeof imported }).default ?? imported;
  send("ready");
  const request = await new Promise<RegionSnapShotRequest>((resolve) => {
    process.once("message", resolve);
  });
  const shot = await xa11y.screenshot({ region: request.region });
  const result: RegionSnapShotResult = {
    type: "result",
    width: shot.width,
    height: shot.height,
    png: shot.toPng().toString("base64"),
  };
  send(result);
}

void capture().catch((error: unknown) =>
  send({
    type: "error",
    message: error instanceof Error ? error.message : "Windows window capture failed.",
  } satisfies RegionSnapShotResult),
);
