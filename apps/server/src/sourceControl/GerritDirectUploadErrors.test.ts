// @effect-diagnostics-next-line nodeBuiltinImport:off -- These tests exercise real Git receive hooks.
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

const host = Layer.unwrap(
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
const layer = Direct.layer.pipe(Layer.provideMerge(Layer.merge(host, secrets)));

it.effect("rejects missing or duplicate Change-Id footers without modifying the commit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "direct-errors-" });
    const run = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
    run("init", "--initial-branch=main");
    run("config", "user.name", "Fixture");
    run("config", "user.email", "fixture@example.invalid");
    run("commit", "--allow-empty", "-m", "Base");
    const base = run("rev-parse", "HEAD").trim();
    run("commit", "--allow-empty", "-m", "Missing");
    const missing = run("rev-parse", "HEAD").trim();
    // The upload resolves the base and the push remote before it validates footers, so give it both.
    run("update-ref", "refs/remotes/origin/main", base);
    run("init", "--bare", "receiver");
    run("remote", "add", "origin", `${cwd}/receiver`);
    const service = yield* Direct.GerritDirectUpload;
    const error = yield* service.upload({ cwd, kind: "new", branch: "main" }).pipe(Effect.flip);
    expect(error.reason).toBe("change-id");
    expect(error.message).toContain("commit-msg");
    expect(run("rev-parse", "HEAD").trim()).toBe(missing);
    const id = `I${"a".repeat(40)}`;
    run("commit", "--allow-empty", "-m", `Duplicate\n\nChange-Id: ${id}\nChange-Id: ${id}`);
    run("update-ref", "refs/remotes/origin/main", missing);
    const duplicate = yield* service.upload({ cwd, kind: "new", branch: "main" }).pipe(Effect.flip);
    expect(duplicate.reason).toBe("change-id");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("reports Gerrit's no new changes rejection as an error", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "direct-rejection-" });
    const run = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
    run("init", "--initial-branch=main");
    run("config", "user.name", "Fixture");
    run("config", "user.email", "fixture@example.invalid");
    run("commit", "--allow-empty", "-m", "Base");
    const base = run("rev-parse", "HEAD").trim();
    run("commit", "--allow-empty", "-m", `Subject\n\nChange-Id: I${"a".repeat(40)}`);
    // The upload resolves the base before it pushes, so give it one.
    run("update-ref", "refs/remotes/origin/main", base);
    run("init", "--bare", "receiver");
    run("remote", "add", "origin", `${cwd}/receiver`);
    yield* fs.writeFileString(
      `${cwd}/receiver/hooks/pre-receive`,
      "#!/bin/sh\necho 'no new changes' >&2\nexit 1\n",
    );
    yield* fs.chmod(`${cwd}/receiver/hooks/pre-receive`, 0o700);
    const service = yield* Direct.GerritDirectUpload;
    const error = yield* service.upload({ cwd, kind: "new", branch: "main" }).pipe(Effect.flip);
    expect(error.reason).toBe("no-new-changes");
    expect(run("--git-dir=receiver", "for-each-ref")).toBe("");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
