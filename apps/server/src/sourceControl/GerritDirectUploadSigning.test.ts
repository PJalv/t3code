// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture creates a key and receives a signed push.
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

it.effect("uses the saved passphrase to sign a direct push certificate", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const processRunner = yield* VcsProcess.VcsProcess;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "direct-signed-" });
    const home = `${cwd}/gnupg`;
    yield* fs.makeDirectory(home, { mode: 0o700 });
    const env = {
      ...process.env,
      GNUPGHOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const run = (command: string, args: string[], input?: string) =>
      NodeChildProcess.execFileSync(command, args, {
        cwd,
        env,
        encoding: "utf8",
        input,
        stdio: ["pipe", "pipe", "pipe"],
      });
    run(
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
      "fixture passphrase\n",
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
    run("git", ["commit", "--allow-empty", "-m", `Subject\n\nChange-Id: I${"a".repeat(40)}`]);
    run("git", ["init", "--bare", "receiver"]);
    run("git", ["--git-dir=receiver", "config", "receive.certNonceSeed", "fixture"]);
    run("git", ["remote", "add", "origin", `${cwd}/receiver`]);
    const patchCommit = run("git", ["rev-parse", "HEAD"]).trim();
    run("git", ["push", "origin", `${patchCommit}:refs/changes/41/94741/7`]);
    yield* fs.writeFileString(
      `${cwd}/receiver/hooks/pre-receive`,
      '#!/bin/sh\ntest "$GIT_PUSH_CERT_STATUS" = G && test "$GIT_PUSH_CERT_NONCE_STATUS" = OK\n',
    );
    yield* fs.chmod(`${cwd}/receiver/hooks/pre-receive`, 0o700);
    run("gpgconf", ["--kill", "gpg-agent"]);
    const host = TestSourceControlHost.layer({
      process: {
        run: (input) => processRunner.run({ ...input, env: { ...input.env, GNUPGHOME: home } }),
      },
    });
    const secrets = Layer.succeed(
      ServerSecretStore.ServerSecretStore,
      ServerSecretStore.ServerSecretStore.of({
        get: () => Effect.succeedSome(new TextEncoder().encode("fixture passphrase")),
        set: () => Effect.void,
        create: () => Effect.void,
        remove: () => Effect.void,
        getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      }),
    );
    yield* fs.writeFileString(`${cwd}/staged.txt`, "staged\n");
    run("git", ["add", "staged.txt"]);
    const previous = run("git", ["rev-parse", "HEAD"]).trim();
    const badSecrets = Layer.succeed(
      ServerSecretStore.ServerSecretStore,
      ServerSecretStore.ServerSecretStore.of({
        get: () => Effect.succeedSome(new TextEncoder().encode("wrong passphrase")),
        set: () => Effect.void,
        create: () => Effect.void,
        remove: () => Effect.void,
        getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      }),
    );
    run("gpgconf", ["--kill", "gpg-agent"]);
    const failure = yield* Effect.gen(function* () {
      const service = yield* Direct.GerritDirectUpload;
      return yield* Effect.flip(service.amendSigned({ cwd }));
    }).pipe(Effect.provide(Direct.layer.pipe(Layer.provide(Layer.merge(host, badSecrets)))));
    expect(failure.reason).toBe("commit-signing");
    expect(run("git", ["rev-parse", "HEAD"]).trim()).toBe(previous);
    expect(run("git", ["diff", "--cached", "--name-only"]).trim()).toBe("staged.txt");
    run("gpgconf", ["--kill", "gpg-agent"]);
    const result = yield* Effect.gen(function* () {
      const service = yield* Direct.GerritDirectUpload;
      const ref = yield* service.fetchPatchSet({
        cwd,
        remote: "origin",
        number: 94741,
        patchSet: 7,
        commit: patchCommit,
      });
      expect(ref).toBe("refs/t3/gerrit/94741/7");
      const mismatch = yield* Effect.flip(
        service.fetchPatchSet({
          cwd,
          remote: "origin",
          number: 94741,
          patchSet: 7,
          commit: "0".repeat(40),
        }),
      );
      expect(mismatch.reason).toBe("fetch");
      expect(run("git", ["rev-parse", ref]).trim()).toBe(patchCommit);
      yield* service.amendSigned({ cwd });
      return yield* service.upload({ cwd, kind: "new", branch: "main", topic: "signed" });
    }).pipe(Effect.provide(Direct.layer.pipe(Layer.provide(Layer.merge(host, secrets)))));
    expect(run("git", ["rev-parse", "HEAD"]).trim()).not.toBe(previous);
    run("git", ["verify-commit", "HEAD"]);
    expect(run("git", ["show", "HEAD:staged.txt"])).toBe("staged\n");
    expect(result.pushed).toBe(true);
    expect(
      run("git", [
        "--git-dir=receiver",
        "rev-parse",
        "refs/for/main%no-publish-comments,topic=signed",
      ]).trim(),
    ).toBe(run("git", ["rev-parse", "HEAD"]).trim());
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(VcsProcess.layer, NodeServices.layer).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
