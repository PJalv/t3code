// @effect-diagnostics processEnvInEffect:off -- Git subprocesses inherit the host environment.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { GerritInstallationId, GerritProjectName, GitCommandError } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as GerritRemotes from "./GerritRemotes.ts";
import { GerritRemoteDiscovery, gerritRemoteConfiguration } from "./remoteBinding.ts";

const decodeInstallationId = Schema.decodeSync(GerritInstallationId);
const decodeProjectName = Schema.decodeSync(GerritProjectName);
const decodeDiscovery = Schema.decodeUnknownSync(GerritRemoteDiscovery);

const installation = decodeInstallationId("https://gerrit.example.test/");
const sshRemoteUrl = "ssh://jorge.sarez@gerrit-ssh.example.test:29418/CICD_Tools";

/**
 * A checkout's tracked branch is the branch its changes target, so discovery must bind it instead
 * of answering "target-required" when the upstream already records exactly one merge branch.
 * These tests drive real Git: a green unit fixture cannot show the failure, because the bug was a
 * fact the service read and then never handed to the binding.
 */
const fixture = Effect.fn("test.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = yield* fs.makeTempDirectoryScoped({
    directory: process.env.TMPDIR,
    prefix: "t3-gerrit-remotes-",
  });
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: cwd,
    XDG_CONFIG_HOME: cwd,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(cwd, "no-global-config"),
    GIT_AUTHOR_NAME: "Fixture Author",
    GIT_AUTHOR_EMAIL: "author@example.invalid",
    GIT_COMMITTER_NAME: "Fixture Committer",
    GIT_COMMITTER_EMAIL: "committer@example.invalid",
  };
  const raw = Effect.fn("test.raw")(function* (args: ReadonlyArray<string>) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd, env }));
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, exitCode };
      }),
    );
  });
  const git = Effect.fn("test.git")(function* (args: ReadonlyArray<string>) {
    const result = yield* raw(args);
    expect(result.exitCode, result.stderr).toBe(0);
    return TestSourceControlHost.processOutput(result.stdout, {
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  });
  yield* git(["init", "--initial-branch=develop/master"]);
  yield* git(["config", "core.hooksPath", path.join(cwd, "disabled-hooks")]);
  yield* git(["config", "commit.gpgSign", "false"]);
  yield* fs.writeFileString(path.join(cwd, "content.txt"), "base");
  yield* git(["add", "content.txt"]);
  yield* git(["commit", "--cleanup=verbatim", "-m", `Base\n\nChange-Id: I${"f".repeat(40)}`]);
  yield* git(["remote", "add", "origin", sshRemoteUrl]);
  const track = Effect.fn("test.track")(function* (branch: string, merge: string) {
    yield* git(["config", `branch.${branch}.remote`, "origin"]);
    yield* git(["config", `branch.${branch}.merge`, merge]);
  });
  const configuration = gerritRemoteConfiguration([
    { installation, sshHost: { host: "gerrit-ssh.example.test" }, bindings: [] },
  ]);
  const host = TestSourceControlHost.layer({
    git: {
      execute: (input) =>
        raw(input.args).pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation: input.operation,
                cwd: input.cwd,
                command: "git",
                detail: "Isolated fixture Git command failed.",
                cause,
              }),
          ),
          Effect.map((result) =>
            TestSourceControlHost.processOutput(result.stdout, {
              stderr: result.stderr,
              exitCode: result.exitCode,
            }),
          ),
        ),
    },
  });
  const remotes = yield* GerritRemotes.GerritRemotes.pipe(
    Effect.provide(GerritRemotes.layer.pipe(Layer.provide(host))),
  );
  return { cwd, configuration, remotes, track, git };
});

describe("checkout Gerrit remote discovery", () => {
  it.live("binds a tracked SSH checkout to the branch its upstream records", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      yield* repo.track("develop/master", "refs/heads/develop/master");
      const discovered = decodeDiscovery(
        yield* repo.remotes.discover({ cwd: repo.cwd, configuration: repo.configuration }),
      );
      expect(discovered.upstream).toEqual({
        kind: "branch",
        localBranch: "develop/master",
        remoteNames: ["origin"],
        mergeBranches: ["develop/master"],
      });
      expect(discovered.binding).toEqual({
        kind: "bound",
        scope: { installation, project: "CICD_Tools", branch: "develop/master" },
      });
      expect(discovered.remotes[0]?.effective.fetch).toEqual([
        { kind: "candidate", repositories: [{ installation, project: "CICD_Tools" }] },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("uses the upstream merge branch rather than the local branch", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      yield* repo.track("develop/master", "refs/heads/main");
      const discovered = yield* repo.remotes.discover({
        cwd: repo.cwd,
        configuration: repo.configuration,
      });
      expect(discovered.binding).toEqual({
        kind: "bound",
        scope: { installation, project: "CICD_Tools", branch: "main" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps multiple repository interpretations ambiguous until exactly bound", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const url = "https://gerrit.example.test/Team/Repo.git";
      yield* repo.git(["remote", "set-url", "origin", url]);
      yield* repo.track("develop/master", "refs/heads/main");
      const ambiguous = yield* repo.remotes.discover({
        cwd: repo.cwd,
        configuration: repo.configuration,
      });
      expect(ambiguous.binding.kind).toBe("ambiguous");
      const configuration = gerritRemoteConfiguration([
        {
          installation,
          bindings: [{ url, project: decodeProjectName("Team/Repo") }],
        },
      ]);
      const exact = yield* repo.remotes.discover({ cwd: repo.cwd, configuration });
      expect(exact.binding).toEqual({
        kind: "bound",
        scope: { installation, project: "Team/Repo", branch: "main" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("does not infer a tracked remote branch for a different selected Gerrit repository", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      yield* repo.track("develop/master", "refs/heads/develop/master");
      yield* repo.git(["remote", "add", "other", "https://gerrit.example.test/Other"]);
      const configuration = gerritRemoteConfiguration([
        {
          installation,
          sshHost: { host: "gerrit-ssh.example.test" },
          bindings: [
            { url: "https://gerrit.example.test/Other", project: decodeProjectName("Other") },
          ],
        },
      ]);
      const discovered = decodeDiscovery(
        yield* repo.remotes.discover({
          cwd: repo.cwd,
          configuration,
          repository: { installation, project: decodeProjectName("Other") },
        }),
      );
      expect(discovered.binding).toEqual({
        kind: "target-required",
        repository: { installation, project: "Other" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("stays target-required when the checkout tracks no upstream branch", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const discovered = decodeDiscovery(
        yield* repo.remotes.discover({ cwd: repo.cwd, configuration: repo.configuration }),
      );
      expect(discovered.upstream).toEqual({ kind: "unsupported" });
      expect(discovered.binding).toEqual({
        kind: "target-required",
        repository: { installation, project: "CICD_Tools" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("does not infer a target from multiple configured upstream remotes", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      yield* repo.track("develop/master", "refs/heads/main");
      yield* repo.git(["config", "--add", "branch.develop/master.remote", "other"]);
      const discovered = yield* repo.remotes.discover({
        cwd: repo.cwd,
        configuration: repo.configuration,
      });
      expect(discovered.binding).toEqual({
        kind: "target-required",
        repository: { installation, project: "CICD_Tools" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("binds an exact binding when the caller supplies the target branch", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const configuration = gerritRemoteConfiguration([
        {
          installation,
          sshHost: { host: "gerrit-ssh.example.test" },
          bindings: [{ url: sshRemoteUrl, project: decodeProjectName("CICD_Tools") }],
        },
      ]);
      // The checkout tracks nothing, so discovery alone cannot name a branch; the caller's
      // target is what makes the scope complete.
      const untargeted = decodeDiscovery(
        yield* repo.remotes.discover({ cwd: repo.cwd, configuration }),
      );
      expect(untargeted.binding).toEqual({
        kind: "target-required",
        repository: { installation, project: "CICD_Tools" },
      });
      const targeted = decodeDiscovery(
        yield* repo.remotes.discover({
          cwd: repo.cwd,
          configuration,
          target: "develop/master" as never,
        }),
      );
      expect(targeted.binding).toEqual({
        kind: "bound",
        scope: { installation, project: "CICD_Tools", branch: "develop/master" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
