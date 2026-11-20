import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as CliError from "effect/cli/CliError";

// A new empty directory is claimed once; an arbitrary existing T3 home is never adopted.
const marker = ".gerrit-beta-home";
export const validateBetaHome = Effect.fn("betaHome.validate")(function* (raw: string | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const refuse = () =>
    new CliError.UserError({
      cause: "Unsafe beta home",
      userMessage:
        "Gerrit beta requires --base-dir with an absolute, isolated directory below your user home (recommended: ~/.t3-gerrit-beta). It must be empty on first use, and must not contain symlinks or use an official .t3 directory.",
    });
  if (!raw || raw !== raw.trim() || !path.isAbsolute(raw)) return yield* refuse();
  const baseDir = path.resolve(raw);
  const relative = path.relative(home, baseDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return yield* refuse();
  if (baseDir.split(/[/\\]/).some((part) => part.toLowerCase() === ".t3")) return yield* refuse();
  let current = home;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = yield* fs.lstat(current).pipe(
      Effect.map((info) => info.type),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
    );
    if (stat !== undefined && (stat !== "Directory" || (yield* fs.realPath(current)) !== current)) {
      return yield* refuse();
    }
  }
  if (yield* fs.exists(baseDir)) {
    const entries = yield* fs.readDirectory(baseDir);
    if (entries.length > 0) {
      // Repositories may legitimately contain symlinks; server-written artifacts may not.
      const contentRoots = new Set([
        path.join(baseDir, "worktrees"),
        path.join(baseDir, "caches", "worktree-checkouts"),
      ]);
      const pending = entries.map((entry) => path.join(baseDir, entry));
      while (pending.length > 0) {
        const target = pending.pop()!;
        const stat = yield* fs.lstat(target);
        if (
          (stat.type !== "File" && stat.type !== "Directory") ||
          (yield* fs.realPath(target)) !== target
        )
          return yield* refuse();
        if (stat.type === "Directory" && !contentRoots.has(target)) {
          for (const entry of yield* fs.readDirectory(target))
            pending.push(path.join(target, entry));
        }
      }
      const identity = yield* fs.readFileString(path.join(baseDir, marker)).pipe(Effect.option);
      if (identity._tag === "None" || identity.value !== "gerrit-beta\n") return yield* refuse();
      return baseDir;
    }
  }
  yield* fs.makeDirectory(baseDir, { recursive: true });
  yield* fs.writeFileString(path.join(baseDir, marker), "gerrit-beta\n", { flag: "wx" });
  return baseDir;
});
