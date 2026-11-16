// @effect-diagnostics-next-line nodeBuiltinImport:off -- Publication uses the OS rename operation.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Validate the sibling paths before publication.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

export const publish = Effect.fn("GerritClonePublication.publish")(function* (input: {
  readonly stage: string;
  readonly checkout: string;
  readonly destination: string;
}) {
  const { stage, checkout, destination } = input;
  const canonical = (value: string) =>
    NodePath.isAbsolute(value) && NodePath.normalize(value) === value && !value.includes("\0");
  const parent = NodePath.dirname(stage);
  if (
    !canonical(stage) ||
    !canonical(checkout) ||
    !canonical(destination) ||
    parent === stage ||
    NodePath.dirname(destination) !== parent ||
    checkout !== NodePath.join(stage, "checkout") ||
    stage === destination
  )
    return { status: "rejected" } as const;

  const platform = yield* HostProcess.Platform;
  return yield* Effect.uninterruptible(
    Effect.promise(async () => {
      if (platform === "win32") {
        try {
          // Windows cannot rename over an empty directory. rmdir never removes its contents.
          await NodeFSP.rmdir(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            return { status: "rejected" } as const;
        }
      }
      try {
        await NodeFSP.rename(checkout, destination);
      } catch {
        return { status: "rejected" } as const;
      }
      return { status: "published" } as const;
    }),
  );
});
