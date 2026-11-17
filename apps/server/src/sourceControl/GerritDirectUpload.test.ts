// @effect-diagnostics-next-line nodeBuiltinImport:off -- Git fixtures exercise the real receive process.
import * as NodeChildProcess from "node:child_process";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { expect } from "vite-plus/test";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Direct from "./GerritDirectUpload.ts";

const hostLayer = Layer.unwrap(
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    return TestSourceControlHost.layer({ process: { run: process.run } });
  }),
).pipe(Layer.provideMerge(VcsProcess.layer), Layer.provideMerge(NodeServices.layer));
const secrets = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeedNone,
    set: () => Effect.void,
    create: () => Effect.void,
    remove: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
  }),
);
const testLayer = Direct.layer.pipe(Layer.provideMerge(Layer.merge(hostLayer, secrets)));
const id = `I${"a".repeat(40)}`;
const fixture = Effect.fn("GerritDirectUpload.test.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "direct-upload-" });
  const run = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  run("init", "--initial-branch=main");
  run("config", "user.name", "Fixture");
  run("config", "user.email", "fixture@example.invalid");
  run("commit", "--allow-empty", "-m", `Subject\n\nChange-Id: ${id}`);
  run("init", "--bare", "receiver");
  run("remote", "add", "origin", `${cwd}/receiver`);
  yield* fs.writeFileString(
    `${cwd}/receiver/hooks/pre-receive`,
    "#!/bin/sh\necho 'https://review.example/c/project/+/123/2' >&2\n",
  );
  yield* fs.chmod(`${cwd}/receiver/hooks/pre-receive`, 0o700);
  return { cwd, run };
});

it.effect("pushes the selected commit for a new change with refspec options", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const service = yield* Direct.GerritDirectUpload;
    const sha = f.run("rev-parse", "HEAD").trim();
    f.run("commit", "--allow-empty", "-m", "Later commit");
    const head = f.run("rev-parse", "HEAD").trim();
    const result = yield* service.upload({
      commit: sha,
      cwd: f.cwd,
      kind: "new",
      branch: "main",
      topic: "a,b",
      reviewers: ["a@example.com"],
      cc: ["b@example.com"],
      wip: true,
      private: true,
    });
    expect(result).toEqual({
      pushed: true,
      changeNumber: 123,
      patchSet: 2,
      url: "https://review.example/c/project/+/123/2",
    });
    expect(
      f.run("--git-dir=receiver", "for-each-ref", "--format=%(refname) %(objectname)"),
    ).toContain(
      `refs/for/main%no-publish-comments,topic=a%2Cb,r=a%40example.com,cc=b%40example.com,wip,private ${sha}`,
    );
    expect(f.run("rev-parse", "HEAD").trim()).toBe(head);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("uploads a matching patch set and rejects a mismatched Change-Id before push", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const service = yield* Direct.GerritDirectUpload;
    const error = yield* service
      .upload({
        cwd: f.cwd,
        kind: "patch-set",
        change: { number: 123, branch: "main", changeId: `I${"b".repeat(40)}` },
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("change-id-mismatch");
    expect(f.run("--git-dir=receiver", "for-each-ref")).toBe("");
    const result = yield* service.upload({
      cwd: f.cwd,
      kind: "patch-set",
      change: { number: 123, branch: "main", changeId: id },
    });
    expect(result.pushed).toBe(true);
    expect(
      f.run("--git-dir=receiver", "rev-parse", "refs/for/main%no-publish-comments").trim(),
    ).toBe(f.run("rev-parse", "HEAD").trim());
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it("keeps Gerrit's rejection lines for the agent without the remote URL's password", () => {
  const output = [
    "To https://jane:hunter2@gerrit.example/a/project",
    "remote: Processing changes: refs: 1, done",
    "remote: ERROR: commit 7d583a9: missing Change-Id in message footer",
    " ! [remote rejected] 7d583a9 -> refs/for/master (commit 7d583a9: missing Change-Id)",
    "error: failed to push some refs to 'https://jane:hunter2@gerrit.example/a/project'",
  ].join("\n");
  const detail = Direct.pushRejection(output);
  expect(detail).toContain("ERROR: commit 7d583a9: missing Change-Id in message footer");
  expect(detail).toContain("! [remote rejected]");
  expect(detail).not.toContain("hunter2");
  expect(detail).not.toContain("Processing changes");
  expect(Direct.pushRejection("Everything up-to-date\n")).toBeUndefined();
});

it.effect("fetches a branch into its remote-tracking ref for the agent to rebase onto", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const service = yield* Direct.GerritDirectUpload;
    f.run("push", "origin", "HEAD:refs/heads/main");
    f.run("commit", "--allow-empty", "-m", `Upstream\n\nChange-Id: I${"b".repeat(40)}`);
    const upstream = f.run("rev-parse", "HEAD").trim();
    f.run("push", "origin", "HEAD:refs/heads/main");
    f.run("reset", "--hard", "HEAD~1");

    const fetched = yield* service.fetchBranch({ cwd: f.cwd, remote: "origin", branch: "main" });
    expect(fetched).toEqual({ ref: "refs/remotes/origin/main", commit: upstream });
    expect(f.run("rev-parse", "origin/main").trim()).toBe(upstream);

    const invalid = yield* Effect.flip(
      service.fetchBranch({ cwd: f.cwd, remote: "origin", branch: "../main" }),
    );
    expect(invalid.reason).toBe("invalid-input");
    const missing = yield* Effect.flip(
      service.fetchBranch({ cwd: f.cwd, remote: "origin", branch: "no-such-branch" }),
    );
    expect(missing.reason).toBe("fetch");
    expect(missing.message).toContain("no-such-branch");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it("points an upload with no common history at fetching the target branch", () => {
  const stale = new Direct.GerritDirectUploadError({
    reason: "push",
    detail: "! [remote rejected] (no common ancestry)",
  });
  expect(stale.message).toContain("fetch_gerrit_branch");
  const other = new Direct.GerritDirectUploadError({ reason: "push", detail: "prohibited" });
  expect(other.message).not.toContain("fetch_gerrit_branch");
});
