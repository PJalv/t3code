// @effect-diagnostics processEnvInEffect:off -- Git subprocesses inherit the host environment.
import * as NodeBuffer from "node:buffer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import {
  GerritChangeRevision,
  GerritReadChange,
  GerritRepositoryScope,
  GerritVisibleChanges,
  GitCommandError,
  GitCommitOid,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as GerritLocalCommits from "./GerritLocalCommits.ts";
import { mapLocalCommits, type LocalCommit } from "./localCommitMapping.ts";

const decodeScope = Schema.decodeUnknownSync(GerritRepositoryScope);
const decodeVisible = Schema.decodeUnknownSync(GerritVisibleChanges);
const decodeChanges = Schema.decodeUnknownSync(Schema.Array(GerritChangeRevision));
const decodeOid = Schema.decodeEffect(GitCommitOid);
const decodeReadChange = Schema.decodeUnknownSync(GerritReadChange);

const ids = ["a", "b", "c"].map((hex) => `I${hex.repeat(40)}`);
const scope = decodeScope({
  installation: "https://review.example:8443/Review/",
  project: "Team/Repo",
  branch: "Release/Next",
});
const visible = decodeVisible({
  observedAt: "2026-10-22T00:00:00.000Z",
  completeness: "complete-visible",
  changes: ids.map((changeId, index) => ({
    key: { ...scope, changeId },
    number: 101 + index,
    revision: { commit: String(index + 1).repeat(40), patchSet: index + 3 },
  })),
});
const oid = Schema.decodeSync(GitCommitOid)("d".repeat(40));

function mapping(message: string, observation = visible) {
  const commits: LocalCommit[] = [{ oid, parents: [], message }];
  return mapLocalCommits({ commits, scope, visible: observation })[0]?.mapping;
}

const fixture = Effect.fn("test.fixture")(function* (graftFile?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = yield* fs.makeTempDirectoryScoped({
    directory: process.env.TMPDIR,
    prefix: "t3-gerrit-local-",
  });
  const commands: ReadonlyArray<string>[] = [];
  let intercept:
    | ((
        args: ReadonlyArray<string>,
        stdout: string,
      ) => ReturnType<typeof TestSourceControlHost.processOutput> | undefined)
    | undefined;
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: cwd,
    XDG_CONFIG_HOME: cwd,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(cwd, "no-global-config"),
    GIT_AUTHOR_NAME: "Unregistered Author",
    GIT_AUTHOR_EMAIL: "unregistered@example.invalid",
    GIT_AUTHOR_DATE: "2026-10-22T00:00:00+0000",
    GIT_COMMITTER_NAME: "Unregistered Committer",
    GIT_COMMITTER_EMAIL: "committer@example.invalid",
    GIT_COMMITTER_DATE: "2026-10-22T00:00:00+0000",
    ...(graftFile === undefined ? {} : { GIT_GRAFT_FILE: graftFile }),
  };
  const git = Effect.fn("test.git")(function* (args: ReadonlyArray<string>, at = cwd) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: at, env }));
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        expect(exitCode, stderr).toBe(0);
        return TestSourceControlHost.processOutput(stdout, { stderr, exitCode });
      }),
    );
  });
  yield* git(["init", "--initial-branch=LocalStack"]);
  yield* git(["config", "core.hooksPath", path.join(cwd, "disabled-hooks")]);
  yield* git(["config", "commit.gpgSign", "false"]);
  const commit = Effect.fn("test.commit")(function* (message: string) {
    yield* fs.writeFileString(path.join(cwd, "content.txt"), message);
    yield* git(["add", "content.txt"]);
    yield* git(["commit", "--cleanup=verbatim", "-m", message]);
    const head = yield* git(["rev-parse", "HEAD"]);
    return yield* decodeOid(head.stdout.trim());
  });
  const base = yield* commit("Base");
  const commits = yield* Effect.forEach(ids, (id, index) =>
    commit(`${String.fromCharCode(65 + index)}\n\nChange-Id: ${id}`),
  );
  const head = yield* git(["rev-parse", "HEAD"]);
  const tip = yield* decodeOid(head.stdout.trim());
  const host = TestSourceControlHost.layer({
    git: {
      execute: (input) =>
        git(input.args, input.cwd).pipe(
          Effect.map((result) => {
            commands.push(input.args);
            return intercept?.(input.args, result.stdout) ?? result;
          }),
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
        ),
    },
  });
  const reader = yield* GerritLocalCommits.GerritLocalCommits.pipe(
    Effect.provide(GerritLocalCommits.layer.pipe(Layer.provide(host))),
  );
  const rawCommit = Effect.fn("test.rawCommit")(function* (
    message: string | Uint8Array,
    options: { readonly parents?: ReadonlyArray<GitCommitOid>; readonly headers?: string } = {},
  ) {
    const tree = (yield* git(["rev-parse", `${tip}^{tree}`])).stdout.trim();
    const parents = (options.parents ?? [tip]).map((parent) => `parent ${parent}\n`).join("");
    const raw = NodeBuffer.Buffer.concat([
      NodeBuffer.Buffer.from(
        `tree ${tree}\n${parents}author A <a@example.invalid> 1792627200 +0000\ncommitter C <c@example.invalid> 1792627200 +0000\n${options.headers ?? ""}\n`,
      ),
      typeof message === "string" ? NodeBuffer.Buffer.from(message) : message,
    ]);
    const file = path.join(cwd, "raw-commit");
    yield* fs.writeFile(file, raw);
    const result = yield* git(["hash-object", "--literally", "-w", "-t", "commit", file]);
    return yield* decodeOid(result.stdout.trim());
  });
  return {
    cwd,
    git,
    commit,
    rawCommit,
    base,
    commits,
    tip,
    fs,
    path,
    reader,
    commands,
    setIntercept: (value: typeof intercept) => {
      intercept = value;
    },
  };
});

describe("thread checkout observation", () => {
  const observe = Effect.fn("test.observeCheckout")(function* (
    repo: Effect.Success<ReturnType<typeof fixture>>,
    local = repo.tip,
    current = oid,
  ) {
    yield* repo.git(["remote", "add", "origin", `${scope.installation}${scope.project}`]);
    yield* repo.git(["config", "branch.LocalStack.remote", "origin"]);
    yield* repo.git(["config", "branch.LocalStack.merge", `refs/heads/${scope.branch}`]);
    yield* repo.git(["update-ref", `refs/remotes/origin/${scope.branch}`, repo.base]);
    const person = {
      name: "Fixture",
      email: "fixture@example.invalid",
      date: "2026-10-22 00:00:00",
      tz: 0,
    };
    const change = decodeReadChange({
      key: { ...scope, changeId: ids[2] },
      number: 103,
      subject: "C",
      status: "NEW",
      workInProgress: false,
      owner: {},
      currentRevision: current,
      currentPatchSet: local === current ? 1 : 2,
      revisions: [...new Set([local, current])].map((commit, index) => ({
        commit,
        patchSet: index + 1,
        parents: [repo.base],
        author: person,
        committer: person,
      })),
    });
    const configuration = { confirmedInstallations: [scope.installation], exactBindings: [] };
    return {
      input: { cwd: repo.cwd, configuration, change },
      read: () => repo.reader.checkout({ cwd: repo.cwd, configuration, change }),
    };
  });
  it.live("recognizes exact current and exact older tips and an older ancestor below HEAD", () =>
    Effect.gen(function* () {
      for (const currentTip of [true, false]) {
        const repo = yield* fixture();
        const test = yield* observe(repo, repo.tip, currentTip ? repo.tip : oid);
        expect((yield* test.read()).kind).toBe(currentTip ? "exact-current" : "exact-older");
        yield* repo.commit(`Stack child\n\nChange-Id: I${"d".repeat(40)}`);
        const result = yield* test.read();
        expect(result.kind).toBe(currentTip ? "exact-current" : "exact-older");
        expect(result.localOid).toBe(repo.tip);
        expect(result.head).not.toBe(repo.tip);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.live(
    "excludes integrated history and treats manually amended commits as local-different",
    () =>
      Effect.gen(function* () {
        const repo = yield* fixture();
        const test = yield* observe(repo);
        yield* repo.git([
          "commit",
          "--amend",
          "--no-edit",
          "--allow-empty",
          "--date=2026-10-23T00:00:00Z",
        ]);
        expect((yield* test.read()).kind).toBe("local-different");
        const amended = (yield* repo.git(["rev-parse", "HEAD"])).stdout.trim();
        yield* repo.git(["update-ref", `refs/remotes/origin/${scope.branch}`, amended]);
        expect((yield* test.read()).kind).toBe("unknown");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.live("rejects duplicate identities even after an exact match", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const test = yield* observe(repo);
      yield* repo.commit(`Duplicate\n\nChange-Id: ${ids[2]}`);
      expect((yield* test.read().pipe(Effect.exit))._tag).toBe("Failure");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.live(
    "rejects ambiguous mappings, wrong target, wrong repository and missing tracking refs",
    () =>
      Effect.gen(function* () {
        for (const mode of ["mapping", "target", "repository", "missing"]) {
          const repo = yield* fixture();
          const test = yield* observe(repo);
          if (mode === "mapping")
            yield* repo.git([
              "config",
              "--add",
              "remote.origin.fetch",
              "+refs/heads/*:refs/remotes/other/*",
            ]);
          if (mode === "target")
            yield* repo.git(["config", "branch.LocalStack.merge", "refs/heads/wrong"]);
          if (mode === "repository")
            yield* repo.git(["remote", "set-url", "origin", `${scope.installation}unrelated`]);
          if (mode === "missing")
            yield* repo.git(["update-ref", "-d", `refs/remotes/origin/${scope.branch}`]);
          expect((yield* test.read().pipe(Effect.exit))._tag).toBe("Failure");
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.live("permits a separate remote but rejects a competing tracking ref mapping", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const test = yield* observe(repo);
      yield* repo.git(["remote", "add", "backup", "https://example.invalid/backup"]);
      expect((yield* test.read()).kind).toBe("exact-older");
      yield* repo.git([
        "config",
        "--add",
        "remote.backup.fetch",
        `+refs/heads/*:refs/remotes/origin/*`,
      ]);
      expect((yield* test.read().pipe(Effect.exit))._tag).toBe("Failure");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.live("rejects shallow and grafted history and merge commits", () =>
    Effect.gen(function* () {
      for (const mode of ["shallow", "grafts", "merge"]) {
        const repo = yield* fixture();
        const test = yield* observe(repo);
        if (mode === "shallow")
          yield* repo.fs.writeFileString(repo.path.join(repo.cwd, ".git/shallow"), `${repo.tip}\n`);
        if (mode === "grafts") {
          yield* repo.fs.makeDirectory(repo.path.join(repo.cwd, ".git/info"), { recursive: true });
          yield* repo.fs.writeFileString(
            repo.path.join(repo.cwd, ".git/info/grafts"),
            `${repo.tip} ${repo.base}\n`,
          );
        }
        if (mode === "merge") {
          const merge = yield* repo.rawCommit(`Merge\n\nChange-Id: I${"d".repeat(40)}`, {
            parents: [repo.tip, repo.base],
          });
          yield* repo.git(["update-ref", "refs/heads/LocalStack", merge]);
        }
        expect((yield* test.read().pipe(Effect.exit))._tag).toBe("Failure");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.live("rejects truncation, ambiguous merge bases and bounded range overflow", () =>
    Effect.gen(function* () {
      for (const mode of ["truncated", "bases", "limit"]) {
        const repo = yield* fixture();
        const test = yield* observe(repo);
        repo.setIntercept((args, stdout) => {
          if (mode === "truncated" && args.includes("cat-file"))
            return { ...TestSourceControlHost.processOutput(stdout), stdoutTruncated: true };
          if (mode === "bases" && args.includes("merge-base"))
            return TestSourceControlHost.processOutput(`${repo.base}\n${repo.tip}\n`);
          if (mode === "limit" && args.includes("rev-list"))
            return TestSourceControlHost.processOutput(
              Array.from({ length: 1001 }, () => repo.tip).join("\n") + "\n",
            );
          return undefined;
        });
        expect((yield* test.read().pipe(Effect.exit))._tag).toBe("Failure");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.live("leaves files, index, config, refs, reflogs and objects unchanged", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const test = yield* observe(repo);
      const snapshot = Effect.fn("test.snapshot")(function* (
        directory = repo.cwd,
      ): Effect.fn.Return<ReadonlyArray<string>, import("effect/PlatformError").PlatformError> {
        const rows: string[] = [];
        for (const name of (yield* repo.fs.readDirectory(directory)).toSorted()) {
          const file = repo.path.join(directory, name);
          const stat = yield* repo.fs.stat(file);
          if (stat.type === "Directory") rows.push(...(yield* snapshot(file)));
          else
            rows.push(
              `${file}\0${NodeBuffer.Buffer.from(yield* repo.fs.readFile(file)).toString("base64")}`,
            );
        }
        return rows;
      });
      const before = yield* snapshot();
      expect((yield* test.read()).kind).toBe("exact-older");
      expect(yield* snapshot()).toEqual(before);
      expect(repo.commands.length).toBeGreaterThan(0);
      for (const args of repo.commands) {
        expect(args.slice(0, 3)).toEqual([
          "--no-lazy-fetch",
          "--no-replace-objects",
          "--no-optional-locks",
        ]);
        expect(
          args.some((arg) =>
            ["fetch", "update-ref", "checkout", "switch", "reset", "status"].includes(arg),
          ),
        ).toBe(false);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("read-only local Gerrit discovery", () => {
  it.live(
    "distinguishes replacement repositories at the same path from stable repository identity",
    () =>
      Effect.gen(function* () {
        const repo = yield* fixture();
        const first = yield* repo.reader.identity(repo.cwd);
        expect(yield* repo.reader.identity(repo.cwd)).toBe(first);
        yield* repo.fs.rename(
          repo.path.join(repo.cwd, ".git"),
          repo.path.join(repo.cwd, "previous-git"),
        );
        yield* repo.git(["init", "--initial-branch=Replacement"]);
        expect(yield* repo.reader.identity(repo.cwd)).not.toBe(first);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.live("maps A-B-C to three distinct changes, including non-HEAD A and B", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const { fs, path } = repo;
      yield* fs.writeFileString(path.join(repo.cwd, "content.txt"), "staged content");
      yield* repo.git(["add", "content.txt"]);
      yield* fs.writeFileString(path.join(repo.cwd, "content.txt"), "dirty worktree");
      yield* fs.writeFileString(path.join(repo.cwd, "untracked.txt"), "keep me");
      const before = yield* repo.git(["status", "--porcelain=v1"]);
      const refs = yield* repo.git(["show-ref"]);
      const index = yield* fs.readFile(path.join(repo.cwd, ".git/index"));
      const result = yield* repo.reader.discover({
        cwd: repo.cwd,
        base: repo.base,
        tip: repo.tip,
        scope,
        visible,
      });
      expect(result.commits.map((commit) => commit.oid)).toEqual(repo.commits);
      expect(result.commits.map((commit) => commit.mapping)).toEqual(
        visible.changes.map((change) => ({ kind: "mapped", change })),
      );
      expect(result.commits.map((commit) => commit.parents)).toEqual([
        [repo.base],
        [repo.commits[0]],
        [repo.commits[1]],
      ]);
      expect(result.observation).toEqual(visible);
      expect((yield* repo.git(["status", "--porcelain=v1"])).stdout).toBe(before.stdout);
      expect((yield* repo.git(["show-ref"])).stdout).toBe(refs.stdout);
      expect(yield* fs.readFile(path.join(repo.cwd, ".git/index"))).toEqual(index);
      expect(yield* fs.readFileString(path.join(repo.cwd, "content.txt"))).toBe("dirty worktree");
      expect(yield* fs.readFileString(path.join(repo.cwd, "untracked.txt"))).toBe("keep me");
      expect((yield* repo.git(["show", "-s", "--format=%ae %ce", repo.tip])).stdout).toContain(
        "unregistered@example.invalid committer@example.invalid",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reads an explicit non-HEAD range without selecting the branch tip", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const [a, b] = repo.commits;
      if (a === undefined || b === undefined) throw new Error("Expected A and B fixture commits.");
      const result = yield* repo.reader.discover({
        cwd: repo.cwd,
        base: a,
        tip: b,
        scope,
        visible,
      });
      expect(result.commits).toMatchObject([
        { oid: b, parents: [a], mapping: { kind: "mapped", change: visible.changes[1] } },
      ]);
      expect((yield* repo.git(["rev-parse", "HEAD"])).stdout.trim()).toBe(repo.tip);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("preserves commit messages regardless of configured log output encoding", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      yield* repo.git(["config", "i18n.logOutputEncoding", "UTF-16"]);
      const result = yield* repo.reader.discover({
        cwd: repo.cwd,
        base: repo.base,
        tip: repo.tip,
        scope,
        visible,
      });
      expect(result.commits.map((commit) => commit.mapping)).toEqual(
        visible.changes.map((change) => ({ kind: "mapped", change })),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.each(["", "encoding UTF-8\n", "encoding UTF8\n"])(
    "preserves raw UTF-8 messages and ignores header continuations with %j",
    (encoding) =>
      Effect.gen(function* () {
        const repo = yield* fixture();
        yield* repo.git(["config", "i18n.logOutputEncoding", "UTF-16"]);
        const message = `Résumé 日本語\r\n\r\nChange-Id: ${ids[0]}\r\n`;
        const tip = yield* repo.rawCommit(message, {
          headers: `${encoding}gpgsig fixture signature\n encoding ISO-8859-1\n Change-Id: ${ids[1]}\n`,
        });
        const result = yield* repo.reader.discover({
          cwd: repo.cwd,
          base: repo.tip,
          tip,
          scope,
          visible,
        });
        expect(result.commits).toMatchObject([
          {
            oid: tip,
            parents: [repo.tip],
            message,
            mapping: { kind: "mapped", change: visible.changes[0] },
          },
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.each(["encoding ISO-8859-1\n", "encoding UTF-8\n continued-encoding\n"])(
    "rejects unsupported or continued encoding headers instead of guessing: %j",
    (headers) =>
      Effect.gen(function* () {
        const repo = yield* fixture();
        const tip = yield* repo.rawCommit(
          NodeBuffer.Buffer.from(`Résumé\n\nChange-Id: ${ids[0]}\n`, "latin1"),
          { headers },
        );
        const error = yield* repo.reader
          .discover({ cwd: repo.cwd, base: repo.tip, tip, scope, visible })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "GerritLocalReadError",
          reason: "unsupported-encoding",
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reads root and merge parents directly from commit objects", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const root = yield* repo.rawCommit(`Root\n\nChange-Id: ${ids[0]}\n`, { parents: [] });
      const rootResult = yield* repo.reader.discover({
        cwd: repo.cwd,
        base: repo.tip,
        tip: root,
        scope,
        visible,
      });
      expect(rootResult.commits).toMatchObject([
        { oid: root, parents: [], mapping: { kind: "mapped", change: visible.changes[0] } },
      ]);
      const merge = yield* repo.rawCommit(`Merge\n\nChange-Id: I${"e".repeat(40)}\n`, {
        parents: [repo.tip, root],
      });
      const result = yield* repo.reader.discover({
        cwd: repo.cwd,
        base: repo.base,
        tip: merge,
        scope,
        visible,
      });
      expect(result.commits.map((commit) => commit.oid).sort()).toEqual(
        [...repo.commits, root, merge].sort(),
      );
      expect(result.commits.at(-1)).toMatchObject({
        oid: merge,
        parents: [repo.tip, root],
        mapping: { kind: "new-candidate" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("ignores replacement refs for both traversal and raw parent reads", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      yield* repo.git(["replace", "--graft", repo.tip]);
      const before = (yield* repo.git(["show-ref"])).stdout;
      const result = yield* repo.reader.discover({
        cwd: repo.cwd,
        base: repo.base,
        tip: repo.tip,
        scope,
        visible,
      });
      expect(result.commits.map((commit) => commit.oid)).toEqual(repo.commits);
      expect(result.commits.map((commit) => commit.parents)).toEqual([
        [repo.base],
        [repo.commits[0]],
        [repo.commits[1]],
      ]);
      expect((yield* repo.git(["show-ref"])).stdout).toBe(before);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.each([
    { name: "the repository graft file", worktree: false, graftFile: undefined },
    {
      name: "the common-dir graft file from a linked worktree",
      worktree: true,
      graftFile: undefined,
    },
    { name: "a relative GIT_GRAFT_FILE override", worktree: false, graftFile: "custom-grafts" },
  ])("rejects ancestry overridden by $name without changing the file", ({ worktree, graftFile }) =>
    Effect.gen(function* () {
      const repo = yield* fixture(graftFile);
      const [a, b] = repo.commits;
      if (a === undefined || b === undefined) throw new Error("Expected A and B fixture commits.");
      const cwd = worktree ? repo.path.join(repo.cwd, "linked") : repo.cwd;
      if (worktree) yield* repo.git(["worktree", "add", "--detach", cwd, b]);
      const graftPath = (yield* repo.git(
        ["rev-parse", "--path-format=absolute", "--git-path", "info/grafts"],
        cwd,
      )).stdout.trim();
      const content = `${b}\n`;
      yield* repo.fs.writeFileString(graftPath, content);
      const error = yield* repo.reader
        .discover({ cwd, base: repo.base, tip: b, scope, visible })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "GerritLocalReadError", reason: "grafted-history" });
      expect(yield* repo.fs.readFileString(graftPath)).toBe(content);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a continued Change-Id instead of mapping its valid-looking first line", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const tip = yield* repo.commit(
        `Continued identity\n\nChange-Id: ${ids[0]}\n continuation makes this value invalid`,
      );
      const result = yield* repo.reader.discover({
        cwd: repo.cwd,
        base: repo.tip,
        tip,
        scope,
        visible,
      });
      expect(result.commits.map((commit) => commit.mapping)).toEqual([
        { kind: "invalid", problems: ["malformed-change-id"] },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a raw NUL-bearing commit instead of mapping the truncated prefix", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const tip = yield* repo.rawCommit(
        `NUL message\n\nChange-Id: ${ids[0]}\n\0\nChange-Id: ${ids[1]}\n`,
      );
      expect((yield* repo.git(["cat-file", "commit", tip])).stdout).toContain("\0");
      const error = yield* repo.reader
        .discover({ cwd: repo.cwd, base: repo.tip, tip, scope, visible })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "GerritLocalReadError", reason: "invalid-output" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("does not present shallow history as a complete local range", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      yield* repo.fs.writeFileString(repo.path.join(repo.cwd, ".git/shallow"), `${repo.tip}\n`);
      const error = yield* repo.reader
        .discover({ cwd: repo.cwd, base: repo.base, tip: repo.tip, scope, visible })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "GerritLocalReadError", reason: "shallow-history" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects truncated local output instead of returning an incomplete range", () =>
    Effect.gen(function* () {
      const reader = yield* GerritLocalCommits.GerritLocalCommits;
      const error = yield* reader
        .discover({ cwd: "/unused", base: oid, tip: oid, scope, visible })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "GerritLocalReadError", reason: "truncated-output" });
    }).pipe(
      Effect.provide(
        GerritLocalCommits.layer.pipe(
          Layer.provide(
            TestSourceControlHost.layer({
              git: {
                execute: () =>
                  Effect.succeed({
                    ...TestSourceControlHost.processOutput(`${oid}\n`),
                    stdoutTruncated: true,
                  }),
              },
            }),
          ),
          Layer.provide(
            Layer.merge(Path.layer, FileSystem.layerNoop({ exists: () => Effect.succeed(false) })),
          ),
        ),
      ),
    ),
  );

  it.effect.each([
    {
      name: "an invalid commit OID",
      listing: "not-an-oid\n",
      commitOutput: "",
      reason: "invalid-output",
    },
    {
      name: "more than 1000 commits",
      listing: Array.from({ length: 1001 }, () => oid).join("\n"),
      commitOutput: "",
      reason: "too-many-commits",
    },
    {
      name: "a missing raw commit header separator",
      listing: `${oid}\n`,
      commitOutput: "missing separator",
      reason: "invalid-output",
    },
    {
      name: "an invalid parent OID",
      listing: `${oid}\n`,
      commitOutput: `tree ${oid}\nparent bad-parent\n\nSubject`,
      reason: "invalid-output",
    },
  ])("fails closed on $name", ({ listing, commitOutput, reason }) =>
    Effect.gen(function* () {
      const reader = yield* GerritLocalCommits.GerritLocalCommits;
      const error = yield* reader
        .discover({ cwd: "/unused", base: oid, tip: oid, scope, visible })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "GerritLocalReadError", reason });
    }).pipe(
      Effect.provide(
        GerritLocalCommits.layer.pipe(
          Layer.provide(
            TestSourceControlHost.layer({
              git: {
                execute: (input) =>
                  Effect.succeed(
                    TestSourceControlHost.processOutput(
                      input.args.includes("--git-path")
                        ? "/unused/info/grafts\n"
                        : input.args.includes("rev-parse")
                          ? "false\n"
                          : input.args.includes("rev-list")
                            ? listing
                            : commitOutput,
                    ),
                  ),
              },
            }),
          ),
          Layer.provide(
            Layer.merge(Path.layer, FileSystem.layerNoop({ exists: () => Effect.succeed(false) })),
          ),
        ),
      ),
    ),
  );

  it.live("reports duplicate identities on distinct local commits instead of merging them", () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const tip = yield* repo.commit(`D\n\nChange-Id: ${ids[0]}`);
      const result = yield* repo.reader.discover({
        cwd: repo.cwd,
        base: repo.base,
        tip,
        scope,
        visible,
      });
      expect(result.commits.map((commit) => commit.mapping.kind)).toEqual([
        "invalid",
        "mapped",
        "mapped",
        "invalid",
      ]);
      expect(result.commits[0]?.mapping).toEqual({
        kind: "invalid",
        problems: ["duplicate-local-change-id"],
      });
      expect(result.commits[3]?.mapping).toEqual({
        kind: "invalid",
        problems: ["duplicate-local-change-id"],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Gerrit commit mapping", () => {
  it("reads the last paragraph footer with other trailers and CRLF", () => {
    expect(
      mapping(
        `Subject\r\n\r\nBody with Change-Id: not-an-id\r\n\r\nBug: 42\r\nChange-Id: ${ids[0]}\r\nSigned-off-by: Person <p@example.invalid>\r\n\r\n`,
      ),
    ).toEqual({ kind: "mapped", change: visible.changes[0] });
  });

  it.each([
    ["Subject", "missing-change-id"],
    [`Change-Id: ${ids[0]}`, "missing-change-id"],
    [`Subject\nChange-Id: ${ids[0]}`, "missing-change-id"],
    [`Subject\n\n Change-Id: ${ids[0]}`, "malformed-change-id"],
    [`Subject\n\nChange-Id: ${ids[0]}\n\nBody, not a footer`, "missing-change-id"],
    ["Subject\n\nChange-Id: invalid", "malformed-change-id"],
    [`Subject\n\nChange-Id: I${"0".repeat(40)}`, "malformed-change-id"],
    [`Subject\n\nChange-Id: i${"a".repeat(40)}`, "malformed-change-id"],
    [`Subject\n\nChange-Id ${ids[0]}`, "malformed-change-id"],
    [`Subject\n\nChange-Id: ${ids[0]}\n continuation`, "malformed-change-id"],
    [`Subject\r\n\r\nChange-Id: ${ids[0]}\r\n continuation`, "malformed-change-id"],
    [`Subject\n\nChange-Id: ${ids[0]}\n\tcontinuation`, "malformed-change-id"],
    [`Subject\n\nChange-Id:\n ${ids[0]}`, "malformed-change-id"],
    [`Subject\n\nBug: 42\n Change-Id: ${ids[0]}`, "missing-change-id"],
    [`Subject\n\nChange-Id: ${ids[0]}\nChange-Id: ${ids[1]}`, "duplicate-change-id"],
    [`Subject\n\nChange-Id: ${ids[0]}\nChange-Id: ${ids[0]}`, "duplicate-change-id"],
    [
      `Subject\n\nLink: https://review.example:8443/Review/id/${ids[0]}`,
      "unsupported-link-trailer",
    ],
    [
      `Subject\n\nChange-Id: ${ids[0]}\nLink: https://review.example/id/${ids[1]}`,
      "unsupported-link-trailer",
    ],
    [
      `Subject\n\nChange-Id: ${ids[0]}\nLink: https://review.example/id/${ids[1]}\n continuation`,
      "unsupported-link-trailer",
    ],
  ])("does not silently select an identity from %s", (message, problem) => {
    expect(mapping(message)).toEqual({ kind: "invalid", problems: [problem] });
  });

  it("does not count another trailer's continuation as an additional Change-Id", () => {
    expect(mapping(`Subject\n\nChange-Id: ${ids[0]}\nBug: 42\n Change-Id: ${ids[1]}`)).toEqual({
      kind: "mapped",
      change: visible.changes[0],
    });
  });

  it.each([
    { project: "team/Repo" },
    { project: "Other/Repo" },
    { branch: "release/Next" },
    { branch: "Other" },
    { installation: "https://review.example:8443/review/" },
    { installation: "https://review.example/Review/" },
    { installation: "http://review.example:8443/Review/" },
    { installation: "https://other.example:8443/Review/" },
  ])("does not match the same Change-Id in another scope %j", (otherScope) => {
    const other = decodeVisible({
      ...visible,
      changes: visible.changes.map((change) => ({
        ...change,
        key: { ...change.key, ...otherScope },
      })),
    });
    expect(mapping(`Subject\n\nChange-Id: ${ids[0]}`, other)).toEqual({
      kind: "new-candidate",
      key: { ...scope, changeId: ids[0] },
    });
  });

  it("matches a single-segment project without introducing a path or changing case", () => {
    const singleScope = decodeScope({ ...scope, project: "Repo" });
    const observation = decodeVisible({
      ...visible,
      changes: visible.changes.map((change) => ({
        ...change,
        key: { ...change.key, project: "Repo" },
      })),
    });
    const result = mapLocalCommits({
      commits: [{ oid, parents: [], message: `Subject\n\nChange-Id: ${ids[0]}` }],
      scope: singleScope,
      visible: observation,
    });
    expect(result[0]?.mapping).toEqual({ kind: "mapped", change: observation.changes[0] });
  });

  it("keeps multiple visible matches and partial observations ambiguous", () => {
    const first = visible.changes[0];
    if (first === undefined) throw new Error("Expected a visible change fixture.");
    const changes = decodeChanges([first, { ...first, number: 999 }]);
    expect(mapping(`Subject\n\nChange-Id: ${ids[0]}`, { ...visible, changes })).toEqual({
      kind: "ambiguous",
      key: { ...scope, changeId: ids[0] },
      candidates: changes,
      reason: "multiple-visible-matches",
    });
    expect(
      mapping(`Subject\n\nChange-Id: ${ids[0]}`, { ...visible, completeness: "partial" }),
    ).toEqual({
      kind: "ambiguous",
      key: { ...scope, changeId: ids[0] },
      candidates: [first],
      reason: "partial-visible-results",
    });
    expect(
      mapping(`Subject\n\nChange-Id: ${ids[0]}`, {
        ...visible,
        changes: [],
        completeness: "partial",
      }),
    ).toEqual({
      kind: "ambiguous",
      key: { ...scope, changeId: ids[0] },
      candidates: [],
      reason: "partial-visible-results",
    });
  });
});
