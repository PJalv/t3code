import { vi } from "vite-plus/test";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as GerritTerminalGit from "../sourceControl/GerritTerminalGit.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { hostShellWord } from "./invocation.ts";
import { Command } from "effect/cli";
import { gerritCommand } from "./gerrit.ts";

it.effect("preserves standard explicit, environment and default home resolution", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "gerrit-standard-" });
    const setup = vi.fn<GerritTerminalGit.GerritTerminalGit["Service"]["setup"]>(() => Effect.void);
    using _service = vi
      .spyOn(GerritTerminalGit, "layer", "get")
      .mockReturnValue(Layer.succeed(GerritTerminalGit.GerritTerminalGit, { setup }));
    for (const input of [
      {
        args: ["--base-dir", path.join(home, "explicit")],
        env: { T3CODE_HOME: path.join(home, "ignored") },
        expected: "explicit",
      },
      { args: [], env: { T3CODE_HOME: path.join(home, "environment") }, expected: "environment" },
      { args: [], env: {}, expected: ".t3" },
    ]) {
      yield* Command.runWith(gerritCommand, { version: "0.0.0" })([
        "copy-terminal-credential",
        "--installation",
        "https://review.example/",
        "--environment-id",
        "env-1",
        ...input.args,
      ]).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, input.env),
      );
      expect(setup).toHaveBeenLastCalledWith(
        expect.objectContaining({ baseDir: path.join(home, input.expected) }),
      );
    }
    expect(yield* fs.readDirectory(home)).toEqual([]);
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.live(
  "round-trips dev and packaged launcher paths through a POSIX shell and parses the CLI flags",
  () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      for (const launcher of [
        ["node", "/server checkout/it's dev/apps/server/src/bin.ts"],
        ["/custom install/it's t3"],
      ]) {
        const args = [
          "gerrit",
          "copy-terminal-credential",
          "--base-dir",
          "/server checkout/it's dev/.t3",
          "--installation",
          "https://review.example/proxy/",
          "--environment-id",
          "env-1",
          "--remote",
          "upstream",
        ];
        // printf parses the substituted template without executing the launcher or touching server state.
        const child = yield* spawner.spawn(
          ChildProcess.make(
            "/bin/sh",
            [
              "-c",
              `printf '%s\\000' ${[...launcher, ...args].map((arg) => hostShellWord("linux", arg)).join(" ")}`,
            ],
            { env: {}, extendEnv: false, stdin: "ignore", stderr: "ignore" },
          ),
        );
        const [output, code] = yield* Effect.all(
          [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
          { concurrency: "unbounded" },
        );
        expect(code).toBe(0);
        const parsed = output.split("\0").slice(0, -1);
        expect(parsed).toEqual([...launcher, ...args]);
        const result = yield* Command.runWith(gerritCommand, { version: "0.0.0" })(
          parsed.slice(launcher.length + 1),
        ).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure).toMatchObject({ reason: "platform" });
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
);

it.effect(
  "parses local setup arguments and rejects unsupported platforms without opening server state",
  () =>
    Effect.gen(function* () {
      const result = yield* Command.runWith(gerritCommand, { version: "0.0.0" })([
        "copy-terminal-credential",
        "--installation",
        "https://review.example/",
        "--environment-id",
        "env-1",
        "--base-dir",
        "/must-not-be-opened",
        "--remote",
        "upstream",
      ]).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toMatchObject({ reason: "platform" });
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
);

it.effect("rejects credential arguments and option injection before setup", () =>
  Effect.gen(function* () {
    for (const args of [
      ["--password", "synthetic-secret"],
      ["--remote", "--upload-pack=evil"],
      ["--installation", "https://alice:secret@review.example/"],
    ]) {
      const result = yield* Command.runWith(gerritCommand, { version: "0.0.0" })([
        "copy-terminal-credential",
        "--installation",
        "https://review.example/",
        "--environment-id",
        "env-1",
        ...args,
      ]).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).not.toMatchObject({ reason: "platform" });
    }
  }).pipe(
    Effect.provideService(HostProcess.Platform, "win32"),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);
