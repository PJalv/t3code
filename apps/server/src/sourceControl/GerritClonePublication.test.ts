// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test inspects real filesystem state.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Build real filesystem fixture paths.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "vite-plus/test";
import * as Publication from "./GerritClonePublication.ts";

it.each([
  ["missing", HostProcess.Platform.defaultValue()],
  ["empty", HostProcess.Platform.defaultValue()],
  ["nonempty", HostProcess.Platform.defaultValue()],
  ["missing", "win32"],
  ["empty", "win32"],
  ["nonempty", "win32"],
] as const)("publishes safely when destination is %s on %s", async (destinationState, platform) => {
  const parent = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gerrit-publish-"));
  const stage = NodePath.join(parent, "stage");
  const checkout = NodePath.join(stage, "checkout");
  const destination = NodePath.join(parent, "destination");
  try {
    await NodeFSP.mkdir(checkout, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(checkout, "source"), "checkout");
    if (destinationState !== "missing") await NodeFSP.mkdir(destination);
    if (destinationState === "nonempty")
      await NodeFSP.writeFile(NodePath.join(destination, "user"), "preserved");
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Exercise the filesystem boundary.
    const result = await Effect.runPromise(
      Publication.publish({ stage, checkout, destination }).pipe(
        Effect.provideService(HostProcess.Platform, platform),
      ),
    );
    if (destinationState === "nonempty") {
      expect(result.status).toBe("rejected");
      expect(await NodeFSP.readFile(NodePath.join(destination, "user"), "utf8")).toBe("preserved");
      expect(await NodeFSP.readFile(NodePath.join(checkout, "source"), "utf8")).toBe("checkout");
    } else {
      expect(result.status).toBe("published");
      expect(await NodeFSP.readFile(NodePath.join(destination, "source"), "utf8")).toBe("checkout");
    }
  } finally {
    await NodeFSP.rm(parent, { recursive: true, force: true });
  }
});
