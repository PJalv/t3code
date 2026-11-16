// @effect-diagnostics nodeBuiltinImport:off -- The fixture queries a disposable local Git repository.
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostSigner from "./HostSignerCapability.ts";

const fixturePath = process.env.PATH;

const childBarrier = vi.hoisted(() => ({
  onSpawn: undefined as ((child: import("node:child_process").ChildProcess) => void) | undefined,
  onPrivate: undefined as ((child: import("node:child_process").ChildProcess) => void) | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: ((...args: unknown[]) => {
      const child = Reflect.apply(
        original.spawn,
        undefined,
        args,
      ) as import("node:child_process").ChildProcess;
      if (args[0] === "/proc/self/fd/3" && Array.isArray(args[1]) && args[1][0] === "config")
        childBarrier.onSpawn?.(child);
      if (
        args[0] === "/proc/self/fd/3" &&
        Array.isArray(args[1]) &&
        args[1].includes("hash-object")
      )
        childBarrier.onPrivate?.(child);
      return child;
    }) as typeof original.spawn,
  };
});

it.live("freezes raw effective Git records and detects included file changes", () =>
  Effect.gen(function* () {
    const repo = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "host-git-config-")),
    );
    const env = {
      PATH: fixturePath,
      HOME: repo,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd: repo, env });
    try {
      git("init", "--quiet");
      const key = "A".repeat(40);
      const inactive = NodePath.join(repo, "inactive");
      const missing = NodePath.join(repo, "missing");
      const subdir = NodePath.join(repo, "subdir");
      const includedPath = NodePath.join(subdir, "included");
      yield* Effect.promise(() => NodeFSP.mkdir(subdir));
      yield* Effect.promise(() => NodeFSP.writeFile(inactive, `[include]\n path = ${missing}\n`));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          includedPath,
          `[user]\n signingkey = ${key}!\n[includeIf "gitdir:/never-match/"]\n path = ../inactive\n`,
        ),
      );
      git("config", "--local", "include.path", includedPath);
      git("config", "--local", "gpg.openpgp.program", "gpg");
      yield* Effect.promise(() =>
        NodeFSP.appendFile(NodePath.join(repo, ".git", "config"), "\n[fixture]\n enabled\n"),
      );
      git("config", "extensions.worktreeConfig", "true");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "-qm",
        "fixture",
      );
      const worktree = NodePath.join(repo, "worktree");
      git("worktree", "add", "-q", "-b", "other", worktree);
      git("-C", worktree, "config", "--worktree", "user.signingkey", `${"B".repeat(40)}!`);
      const selectedBytes = Buffer.from([0xff, 0, 0x61, 0x0a]);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(repo, "selected"), selectedBytes),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(repo, "unrelated"), "staged unrelated"),
      );
      git("add", "unrelated");
      const originalIndex = git("ls-files", "--stage", "-z");
      const originalHead = git("rev-parse", "HEAD").toString().trim();
      const layer = HostSigner.layer.pipe(
        Layer.provide(Layer.succeed(HostProcess.Environment, { PATH: fixturePath, HOME: repo })),
      );
      const host = TestSourceControlHost.layer({
        process: {
          run: (input) =>
            Effect.sync(() => {
              const bytes = NodeChildProcess.execFileSync(input.command, input.args, {
                cwd: input.cwd,
                env: input.env,
              });
              input.onStdoutChunk?.(bytes);
              return TestSourceControlHost.processOutput("");
            }),
        },
      });
      yield* Effect.gen(function* () {
        const issuer = yield* HostSigner.HostSignerIssuer;
        const frozen = yield* issuer.freezeGitConfig(repo);
        expect(frozen.fingerprint).toBe(key);
        const privateIndex = yield* issuer.openPrivateIndex(frozen);
        expect(
          (yield* issuer.runPrivateGit(privateIndex, { kind: "head" })).toString().trim(),
        ).toBe(originalHead);
        yield* issuer.runPrivateGit(privateIndex, { kind: "read-tree", commit: originalHead });
        const blob = (yield* issuer.runPrivateGit(privateIndex, {
          kind: "hash-blob",
          bytes: selectedBytes,
        }))
          .toString()
          .trim();
        expect(yield* issuer.runPrivateGit(privateIndex, { kind: "cat-blob", oid: blob })).toEqual(
          selectedBytes,
        );
        yield* issuer.runPrivateGit(privateIndex, {
          kind: "update-index",
          mode: "100644",
          oid: blob,
          path: "selected",
        });
        const tree = (yield* issuer.runPrivateGit(privateIndex, { kind: "write-tree" }))
          .toString()
          .trim();
        expect(tree).toMatch(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
        const original = yield* issuer.runPrivateGit(privateIndex, {
          kind: "cat-commit",
          commit: originalHead,
        });
        const amended = Buffer.concat([
          Buffer.from(`tree ${tree}\n`),
          original.subarray(original.indexOf(10) + 1),
        ]);
        const commit = (yield* issuer.runPrivateGit(privateIndex, {
          kind: "hash-commit",
          bytes: amended,
        }))
          .toString()
          .trim();
        expect(yield* issuer.runPrivateGit(privateIndex, { kind: "cat-commit", commit })).toEqual(
          amended,
        );
        yield* issuer.runPrivateGit(privateIndex, { kind: "remove-index", path: "selected" });
        expect(
          (yield* issuer.runPrivateGit(privateIndex, { kind: "write-tree" })).toString().trim(),
        ).not.toBe(tree);
        expect(git("ls-files", "--stage", "-z")).toEqual(originalIndex);
        expect(git("rev-parse", "HEAD").toString().trim()).toBe(originalHead);
        const privateSpawned = Promise.withResolvers<import("node:child_process").ChildProcess>();
        childBarrier.onPrivate = (child) => {
          child.kill("SIGSTOP");
          privateSpawned.resolve(child);
        };
        const privateOperation = yield* issuer
          .runPrivateGit(privateIndex, { kind: "hash-blob", bytes: selectedBytes })
          .pipe(Effect.forkChild);
        const privateChild = yield* Effect.promise(() => privateSpawned.promise);
        childBarrier.onPrivate = undefined;
        const inputPath = yield* Effect.promise(() =>
          NodeFSP.readlink(`/proc/${privateChild.pid!}/fd/0`),
        );
        expect((yield* Effect.promise(() => NodeFSP.stat(inputPath))).mode & 0o777).toBe(0o600);
        yield* Fiber.interrupt(privateOperation);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.access(inputPath).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        expect(() => process.kill(privateChild.pid!, 0)).toThrowError(
          expect.objectContaining({ code: "ESRCH" }),
        );
        expect(git("ls-files", "--stage", "-z")).toEqual(originalIndex);
        yield* Effect.promise(() => NodeFSP.writeFile(missing, "[fixture]\n value = appeared\n"));
        expect((yield* issuer.revalidateGitConfig(frozen).pipe(Effect.flip)).reason).toBe(
          "changed",
        );
        yield* Effect.promise(() => NodeFSP.unlink(missing));
        yield* issuer.revalidateGitConfig(frozen);
        yield* issuer.revalidateGitConfig(frozen);
        const worktreeConfig = yield* issuer.freezeGitConfig(worktree);
        expect(worktreeConfig.fingerprint).toBe("B".repeat(40));
        yield* issuer.revalidateGitConfig(worktreeConfig);
        const spawned = Promise.withResolvers<import("node:child_process").ChildProcess>();
        childBarrier.onSpawn = (child) => {
          child.kill("SIGSTOP");
          spawned.resolve(child);
        };
        const query = yield* issuer.revalidateGitConfig(worktreeConfig).pipe(Effect.forkChild);
        yield* Effect.gen(function* () {
          const child = yield* Effect.promise(() => spawned.promise);
          childBarrier.onSpawn = undefined;
          yield* Fiber.interrupt(query);
          const interrupted = yield* Fiber.await(query);
          expect(interrupted._tag).toBe("Failure");
          expect(() => process.kill(child.pid!, 0)).toThrowError(
            expect.objectContaining({ code: "ESRCH" }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              childBarrier.onSpawn = undefined;
            }),
          ),
        );
        git("-C", worktree, "symbolic-ref", "HEAD", "refs/heads/replaced");
        expect((yield* issuer.revalidateGitConfig(worktreeConfig).pipe(Effect.flip)).reason).toBe(
          "changed",
        );
        git("-C", worktree, "symbolic-ref", "HEAD", "refs/heads/other");
        const afterHead = yield* issuer.freezeGitConfig(worktree);
        yield* Effect.promise(() => NodeFSP.chmod(inactive, 0o666));
        expect((yield* issuer.revalidateGitConfig(afterHead).pipe(Effect.flip)).reason).toBe(
          "changed",
        );
        yield* Effect.promise(() => NodeFSP.chmod(inactive, 0o644));
        yield* Effect.promise(() =>
          NodeFSP.appendFile(includedPath, "# changed without record change\n"),
        );
        expect((yield* issuer.revalidateGitConfig(frozen).pipe(Effect.flip)).reason).toBe(
          "changed",
        );
        yield* Effect.promise(() => NodeFSP.symlink(repo, NodePath.join(subdir, "link")));
        yield* Effect.promise(() =>
          NodeFSP.appendFile(
            includedPath,
            '[includeIf "gitdir:/never-match/"]\n path = link/../inactive\n',
          ),
        );
        expect((yield* issuer.freezeGitConfig(repo).pipe(Effect.flip)).reason).toBe("changed");
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(host))));
      const unsafe = NodePath.join(repo, "unsafe");
      yield* Effect.promise(() => NodeFSP.mkdir(unsafe));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(unsafe, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }),
      );
      const unsafeLayer = HostSigner.layer.pipe(
        Layer.provide(
          Layer.succeed(HostProcess.Environment, {
            PATH: `${unsafe}:${fixturePath}`,
            HOME: repo,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const issuer = yield* HostSigner.HostSignerIssuer;
        expect((yield* issuer.freezeGitConfig(repo).pipe(Effect.flip)).reason).toBe("untrusted");
      }).pipe(Effect.provide(unsafeLayer));
      const injectedLayer = HostSigner.layer.pipe(
        Layer.provide(
          Layer.succeed(HostProcess.Environment, {
            PATH: fixturePath,
            HOME: repo,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "user.signingkey",
            GIT_CONFIG_VALUE_0: `${key}!`,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const issuer = yield* HostSigner.HostSignerIssuer;
        expect((yield* issuer.freezeGitConfig(repo).pipe(Effect.flip)).reason).toBe("untrusted");
      }).pipe(Effect.provide(injectedLayer.pipe(Layer.provideMerge(host))));
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(repo, { recursive: true, force: true }));
    }
  }),
);
