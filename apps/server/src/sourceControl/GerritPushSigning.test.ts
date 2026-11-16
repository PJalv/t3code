// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture creates a real key and receives signed Git pushes.
import * as NodeChildProcess from "node:child_process";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { expect } from "vite-plus/test";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { preparePushSigning } from "./GerritPushSigning.ts";

const hostLayer = Layer.unwrap(
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    return TestSourceControlHost.layer({ process: { run: process.run } });
  }),
).pipe(Layer.provideMerge(VcsProcess.layer), Layer.provideMerge(NodeServices.layer));

const fixture = Effect.fn("GerritPushSigning.test.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const host = yield* SourceControlHost.SourceControlHost;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-push-signing-" });
  const home = `${cwd}/gnupg`;
  yield* fs.makeDirectory(home, { mode: 0o700 });
  const env = {
    ...process.env,
    GNUPGHOME: home,
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const run = (command: string, args: string[]) =>
    NodeChildProcess.execFileSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  NodeChildProcess.execFileSync(
    "gpg",
    [
      "--batch",
      "--pinentry-mode",
      "loopback",
      "--passphrase-fd",
      "0",
      "--quick-generate-key",
      "Fixture <fixture@example.invalid>",
      "ed25519",
      "sign",
      "0",
    ],
    { env, input: "fixture passphrase\n", stdio: ["pipe", "pipe", "pipe"] },
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      NodeChildProcess.spawnSync("gpgconf", ["--kill", "gpg-agent"], { env, stdio: "ignore" });
    }),
  );
  run("git", ["init", "--initial-branch=main"]);
  run("git", ["config", "user.name", "Fixture"]);
  run("git", ["config", "user.email", "fixture@example.invalid"]);
  run("git", ["config", "user.signingkey", "fixture@example.invalid"]);
  // Repository signer programs must never receive the saved passphrase.
  run("git", ["config", "gpg.program", "/does-not-exist"]);
  run("git", ["commit", "--allow-empty", "-m", "Fixture"]);
  run("git", ["clone", "--bare", ".", "isolated"]);
  run("git", ["init", "--bare", "receiver"]);
  run("git", ["-C", "receiver", "config", "receive.certNonceSeed", "fixture-nonce-seed"]);
  yield* fs.writeFileString(
    `${cwd}/receiver/hooks/pre-receive`,
    '#!/bin/sh\ntest "$GIT_PUSH_CERT_STATUS" = G && test "$GIT_PUSH_CERT_NONCE_STATUS" = OK\n',
  );
  yield* fs.chmod(`${cwd}/receiver/hooks/pre-receive`, 0o700);
  // Force the saved passphrase path rather than relying on the generation-time cache.
  run("gpgconf", ["--kill", "gpg-agent"]);
  const push = (signing: Effect.Success<ReturnType<typeof preparePushSigning>>) =>
    host.process.run({
      operation: "GerritPushSigning.test.push",
      command: "git",
      cwd: `${cwd}/isolated`,
      args: [
        "--git-dir",
        `${cwd}/isolated`,
        ...signing.args,
        "push",
        "--signed=if-asked",
        "--",
        `${cwd}/receiver`,
        "HEAD:refs/heads/main",
      ],
      env: { ...env, ...signing.env },
      extendEnv: false,
      allowNonZeroExit: true,
      timeoutMs: 60_000,
      maxOutputBytes: 65536,
    });
  return { cwd, env, fs, push, run };
});

it.live(
  "unlocks the saved GPG key and sends a verified push certificate from an isolated checkout",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const signing = yield* preparePushSigning({
        cwd: f.cwd,
        directory: f.cwd,
        env: f.env,
        passphrase: Redacted.make("fixture passphrase"),
      });
      const wrapper = yield* f.fs.readFileString(`${f.cwd}/t3-sign-push`);
      expect(wrapper).not.toContain("fixture passphrase");
      expect(wrapper).toContain("unset GIT_CONFIG_COUNT");
      expect(signing.args.join(" ")).not.toContain("fixture passphrase");
      expect(JSON.stringify(signing.env)).not.toContain("fixture passphrase");
      const pushed = yield* f.push(signing);
      expect(pushed.exitCode, pushed.stderr).toBe(0);
      expect(f.run("git", ["--git-dir=receiver", "rev-parse", "refs/heads/main"]).trim()).toBe(
        f.run("git", ["rev-parse", "HEAD"]).trim(),
      );
    }).pipe(Effect.scoped, Effect.provide(hostLayer)),
);

it.live("rejects a wrong saved passphrase before preparing the push", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const error = yield* preparePushSigning({
      cwd: f.cwd,
      directory: f.cwd,
      env: f.env,
      passphrase: Redacted.make("wrong passphrase"),
    }).pipe(Effect.flip);
    expect(error.reason).toBe("passphrase-rejected");
    expect(yield* f.fs.exists(`${f.cwd}/t3-sign-push`)).toBe(false);
    expect(f.run("git", ["--git-dir=receiver", "for-each-ref"])).toBe("");
  }).pipe(Effect.scoped, Effect.provide(hostLayer)),
);
