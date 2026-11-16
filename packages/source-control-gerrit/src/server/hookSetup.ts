import { GerritHookError, GerritHookSource, type GerritHookDiagnosis } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { officialCommitMsgHook } from "./commitMsgHook.ts";

const source = GerritHookSource.make({
  version: "3.10.2",
  source:
    "https://gerrit.googlesource.com/gerrit/+/refs/tags/v3.10.2/resources/com/google/gerrit/server/tools/root/hooks/commit-msg",
  sha256: "056bce3d91a208d433d3e3e07d427c9b6d9b3d32d67d5f03d3a8115ff32b5b64",
  license: "Apache-2.0",
});

export const makeHookOperations = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const hash = Effect.fn("GerritHook.hash")((text: string) =>
    digest.digest(Digest.sha256, new TextEncoder().encode(text)).pipe(
      Effect.map((value) => Buffer.from(value).toString("hex")),
      Effect.mapError((cause) => new GerritHookError({ reason: "local-read", cause })),
    ),
  );
  const git = Effect.fn("GerritHook.git")(function* (cwd: string, args: ReadonlyArray<string>) {
    const result = yield* host.process
      .run({
        operation: "GerritHook.read",
        command: "git",
        cwd,
        args: ["--no-lazy-fetch", "--no-replace-objects", "--no-optional-locks", ...args],
        allowNonZeroExit: true,
        timeoutMs: 10000,
        maxOutputBytes: 65536,
        outputMode: "error",
      })
      .pipe(Effect.mapError((cause) => new GerritHookError({ reason: "local-read", cause })));
    if (
      result.stdoutTruncated ||
      result.stderrTruncated ||
      result.stdoutInvalidUtf8 ||
      (result.exitCode !== 0 && !(args[0] === "config" && result.exitCode === 1))
    ) {
      return yield* new GerritHookError({ reason: "local-read" });
    }
    return result.stdout;
  });
  const readHook = Effect.fn("GerritHook.readHook")(function* (cwd: string) {
    const rawCommon = (yield* git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).replace(/\r?\n$/, "");
    const rawGit = (yield* git(cwd, ["rev-parse", "--absolute-git-dir"])).replace(/\r?\n$/, "");
    const destination = (yield* git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "hooks/commit-msg",
    ])).replace(/\r?\n$/, "");
    if (
      [rawCommon, rawGit, destination].some(
        (value) => !path.isAbsolute(value) || /[\0\r\n]/.test(value),
      )
    )
      return yield* new GerritHookError({ reason: "local-read" });
    const common = yield* fs
      .realPath(rawCommon)
      .pipe(Effect.mapError((cause) => new GerritHookError({ reason: "local-read", cause })));
    const gitDir = yield* fs
      .realPath(rawGit)
      .pipe(Effect.mapError((cause) => new GerritHookError({ reason: "local-read", cause })));
    const config = yield* git(cwd, [
      "config",
      "--null",
      "--show-origin",
      "--show-scope",
      "--get-regexp",
      "^(core\\.hookspath|gerrit\\.(createchangeid|reviewurl)|trailer\\..*)$",
    ]);
    const create = (yield* git(cwd, ["config", "--get", "gerrit.createChangeId"])).trim();
    const reviewUrl = (yield* git(cwd, ["config", "--get", "gerrit.reviewUrl"])).trim();
    const issues: string[] = [];
    if (create === "false") issues.push("change-id-generation-disabled");
    else if (create !== "always") issues.push("fixup-and-squash-generation-suppressed");
    if (reviewUrl !== "") issues.push("link-trailer-generation-unsupported");
    const directory = path.dirname(destination);
    let safe = destination === path.join(common, "hooks", "commit-msg");
    if (!safe) issues.push("custom-hooks-path-installation-unsupported");
    const dirResult = yield* fs.realPath(directory).pipe(Effect.result);
    if (dirResult._tag === "Success" && dirResult.success !== directory) safe = false;
    if (dirResult._tag === "Failure") safe = false;
    const symlink = yield* fs.readLink(destination).pipe(Effect.result);
    if (symlink._tag === "Success") safe = false;
    else if (
      symlink.failure.reason._tag !== "NotFound" &&
      symlink.failure.reason._tag !== "BadResource"
    ) {
      const info = yield* fs.stat(destination).pipe(Effect.result);
      if (info._tag === "Failure" || info.success.type !== "File") safe = false;
    }
    let state: GerritHookDiagnosis["state"] = "missing";
    let hookDigest = "missing";
    let mode = 0;
    const info = yield* fs.stat(destination).pipe(Effect.result);
    if (info._tag === "Success") {
      mode = info.success.mode;
      if (info.success.type !== "File" || info.success.size > 65536) safe = false;
      else if (safe) {
        const bytes = yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(destination, { flag: "r", noFollow: true });
            return yield* file.readAlloc(65537);
          }),
        ).pipe(Effect.mapError((cause) => new GerritHookError({ reason: "local-read", cause })));
        hookDigest = yield* hash(
          new TextDecoder().decode(Option.getOrElse(bytes, () => new Uint8Array())),
        );
        state = hookDigest === source.sha256 && (mode & 0o111) !== 0 ? "official" : "custom";
      } else state = "custom";
    } else if (info.failure.reason._tag !== "NotFound")
      return yield* new GerritHookError({ reason: "local-read", cause: info.failure });
    if (!safe) {
      state = "unsafe";
      issues.push("unsafe-hook-destination");
    }
    if (state === "custom") issues.push("existing-hook-not-replaced-or-chained");
    const commonInfo = yield* fs
      .stat(common)
      .pipe(Effect.mapError((cause) => new GerritHookError({ reason: "local-read", cause })));
    const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
    const gitInfo = yield* fs
      .stat(gitDir)
      .pipe(Effect.mapError((cause) => new GerritHookError({ reason: "local-read", cause })));
    const directoryInfo = yield* fs.stat(directory).pipe(Effect.result);
    const directoryIdentity =
      directoryInfo._tag === "Success"
        ? `${directoryInfo.success.dev}:${Option.getOrNull(directoryInfo.success.ino)}`
        : "unavailable";
    const repository = yield* encode([
      gitDir,
      common,
      String(commonInfo.dev),
      Option.getOrNull(commonInfo.ino)?.toString() ?? "unknown",
      String(gitInfo.dev),
      Option.getOrNull(gitInfo.ino)?.toString() ?? "unknown",
      directoryIdentity,
    ]).pipe(Effect.mapError((cause) => new GerritHookError({ reason: "local-read", cause })));
    const configuration = yield* hash(config);
    return {
      repository,
      destination,
      source,
      state,
      issues,
      configuration,
      fingerprint: yield* hash(
        yield* encode([
          repository,
          destination,
          configuration,
          hookDigest,
          String(mode),
          String(safe),
        ]).pipe(Effect.mapError((cause) => new GerritHookError({ reason: "local-read", cause }))),
      ),
    } satisfies GerritHookDiagnosis;
  });
  const installHook = Effect.fn("GerritHook.install")(function* (
    cwd: string,
    expected: GerritHookDiagnosis,
    authorize: Effect.Effect<void, GerritHookError>,
  ) {
    const current = yield* readHook(cwd);
    if (current.fingerprint !== expected.fingerprint)
      return yield* new GerritHookError({ reason: "stale" });
    if (current.state !== "missing") return yield* new GerritHookError({ reason: "conflict" });
    if (
      current.issues.includes("link-trailer-generation-unsupported") ||
      current.issues.includes("change-id-generation-disabled")
    )
      return yield* new GerritHookError({ reason: "unsafe" });
    if ((yield* hash(officialCommitMsgHook)) !== source.sha256)
      return yield* new GerritHookError({ reason: "unsafe" });
    const directory = path.dirname(current.destination);
    if (
      (yield* fs
        .realPath(directory)
        .pipe(Effect.mapError((cause) => new GerritHookError({ reason: "filesystem", cause })))) !==
      directory
    )
      return yield* new GerritHookError({ reason: "unsafe" });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* fs.makeTempDirectoryScoped({
          directory,
          prefix: ".t3-commit-msg-",
        });
        const filename = path.join(temporary, "commit-msg");
        yield* fs.writeFileString(filename, officialCommitMsgHook, { flag: "wx", mode: 0o755 });
        yield* fs.chmod(filename, 0o755);
        const fresh = yield* readHook(cwd);
        if (fresh.fingerprint !== expected.fingerprint)
          return yield* new GerritHookError({ reason: "stale" });
        yield* authorize;
        yield* fs.link(filename, current.destination);
      }),
    ).pipe(
      Effect.catchTags({
        PlatformError: (cause) => Effect.fail(new GerritHookError({ reason: "filesystem", cause })),
      }),
    );
    return yield* readHook(cwd);
  });
  return { readHook, installHook };
});
