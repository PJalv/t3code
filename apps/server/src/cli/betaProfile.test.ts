import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import { makeCli } from "../binCli.ts";
import * as GerritTerminalGit from "../sourceControl/GerritTerminalGit.ts";
import { resolveServerConfig, type CliServerFlags } from "./config.ts";

import { validateBetaHome } from "./betaHome.ts";

vi.mock("../buildProfile.ts", () => ({
  isGerritBeta: true,
  gerritBetaRefusal: "Gerrit beta handoff refused",
}));

const flagsFor = (home: string, cwd: string): CliServerFlags => ({
  baseDir: Option.some(home),
  cwd: Option.some(cwd),
  mode: Option.some("desktop"),
  port: Option.some(4774),
  host: Option.some("0.0.0.0"),
  noBrowser: Option.some(false),
  devUrl: Option.none(),
  bootstrapFd: Option.none(),
  autoBootstrapProjectFromCwd: Option.none(),
  logWebSocketEvents: Option.none(),
  tailscaleServeEnabled: Option.some(true),
  tailscaleServePort: Option.none(),
  lan: Option.some(true),
});

it.layer(NodeServices.layer)("Gerrit beta profile", (it) => {
  it.effect(
    "claims an explicit home with spaces without touching official state or inherited home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "beta user " });
        const official = path.join(home, ".t3");
        yield* fs.makeDirectory(official);
        yield* fs.writeFileString(path.join(official, "sentinel"), "official state");
        const beta = path.join(home, "fork state with spaces");
        const config = yield* resolveServerConfig(flagsFor(beta, home), Option.none(), {
          startupPresentation: "headless",
          forceAutoBootstrapProjectFromCwd: false,
        }).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provide(
            Layer.merge(
              NetService.layer,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    T3CODE_HOME: official,
                    T3CODE_MODE: "desktop",
                    T3CODE_LAN: "true",
                    T3CODE_TRACE_FILE: path.join(official, "trace.jsonl"),
                    VITE_DEV_SERVER_URL: "http://127.0.0.1:9999",
                  },
                }),
              ),
            ),
          ),
        );
        expect(config.baseDir).toBe(beta);
        expect(config.dbPath).toBe(path.join(beta, "userdata", "statev2.sqlite"));
        expect(config.serverTracePath.startsWith(beta + path.sep)).toBe(true);
        expect(config.devUrl).toBeUndefined();
        expect(config).toMatchObject({
          mode: "web",
          host: "127.0.0.1",
          port: 4774,
          noBrowser: true,
          tailscaleServeEnabled: false,
          startupPresentation: "headless",
        });
        expect(
          yield* validateBetaHome(beta).pipe(
            Effect.provideService(HostProcess.HomeDirectory, home),
          ),
        ).toBe(beta);
        expect(yield* fs.readDirectory(official)).toEqual(["sentinel"]);
        expect(yield* fs.readFileString(path.join(official, "sentinel"))).toBe("official state");
      }),
  );

  it.effect(
    "rejects missing, official, unmarked, outside-home and linked homes before writes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "beta-home-test-" });
        const official = path.join(home, ".t3");
        yield* fs.makeDirectory(official);
        yield* fs.writeFileString(path.join(official, "sentinel"), "unchanged");
        const existing = path.join(home, "existing");
        yield* fs.makeDirectory(existing);
        yield* fs.writeFileString(path.join(existing, "settings.json"), "{}");
        const alias = path.join(home, "alias");
        yield* fs.symlink(official, alias);
        for (const candidate of [
          undefined,
          "",
          "relative",
          ` ${path.join(home, "spaced")}`,
          home,
          official,
          path.join(official, "beta"),
          existing,
          path.dirname(home),
          alias,
          path.join(alias, "beta"),
        ]) {
          const result = yield* validateBetaHome(candidate).pipe(
            Effect.provideService(HostProcess.HomeDirectory, home),
            Effect.result,
          );
          expect(result._tag).toBe("Failure");
        }
        expect(yield* fs.readDirectory(official)).toEqual(["sentinel"]);
        expect(yield* fs.readDirectory(existing)).toEqual(["settings.json"]);
      }),
  );

  it.effect.each([
    "userdata/statev2.sqlite",
    "userdata/statev2.sqlite-wal",
    "userdata/statev2.sqlite-shm",
    "userdata/state.sqlite",
    "userdata/environment-id",
    "userdata/server-runtime.json",
    "userdata/settings.json",
    "userdata/secrets/credential",
    "userdata/secrets",
    "userdata/logs/provider",
    "userdata/themes/nested/theme.json",
    "userdata/attachments",
    "userdata/attachments/message-attachment.png",
    "userdata/attachments/nested/payload.bin",
    "userdata/browser-artifacts",
    "userdata/browser-artifacts/screenshot.png",
    "worktrees",
    "caches/worktree-checkouts",
    "runtime/selection.json",
    "caches/provider/state.json",
  ])("rejects marked homes with nested links at %s before initialization", (relative) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "beta-nested-" });
      const official = path.join(home, ".t3", "userdata");
      yield* fs.makeDirectory(official, { recursive: true });
      const sentinel = path.join(official, "sentinel");
      yield* fs.writeFileString(sentinel, "unchanged");
      const beta = path.join(home, "beta");
      yield* validateBetaHome(beta).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
      const link = path.join(beta, relative);
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      const target =
        relative === "userdata/secrets" || relative === "userdata/logs/provider"
          ? official
          : sentinel;
      yield* fs.symlink(target, link);
      const result = yield* resolveServerConfig(flagsFor(beta, home), Option.none()).pipe(
        Effect.result,
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provide(
          Layer.merge(NetService.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(yield* fs.readLink(link)).toBe(target);
      expect(yield* fs.readDirectory(official)).toEqual(["sentinel"]);
      expect(yield* fs.readFileString(sentinel)).toBe("unchanged");
      if (relative !== "worktrees")
        expect(yield* fs.exists(path.join(beta, "worktrees"))).toBe(false);
    }),
  );

  it.effect("checks checkout boundaries without scanning repository content", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "beta-content-" });
      const beta = path.join(home, "beta");
      yield* validateBetaHome(beta).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
      const roots = ["worktrees", "caches/worktree-checkouts"].map((relative) =>
        path.join(beta, relative),
      );
      for (const root of roots) yield* fs.makeDirectory(root, { recursive: true });
      expect(
        yield* validateBetaHome(beta).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (target, options) =>
              roots.includes(target)
                ? Effect.die("must not enumerate user content")
                : fs.readDirectory(target, options),
          }),
        ),
      ).toBe(beta);
      const dangling = path.join(beta, "userdata", "settings.json");
      yield* fs.makeDirectory(path.dirname(dangling), { recursive: true });
      const missing = path.join(home, ".t3", "missing");
      yield* fs.symlink(missing, dangling);
      expect(
        (yield* validateBetaHome(beta).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(yield* fs.readLink(dangling)).toBe(missing);
      expect(yield* fs.exists(missing)).toBe(false);
    }),
  );

  it.effect(
    "requires a safe explicit beta home for the Gerrit credential command before setup",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "beta gerrit " });
        const official = path.join(home, ".t3");
        yield* fs.makeDirectory(official);
        yield* fs.writeFileString(path.join(official, "sentinel"), "unchanged");
        const beta = path.join(home, "beta state");
        yield* validateBetaHome(beta).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
        const alias = path.join(home, "linked");
        yield* fs.symlink(official, alias);
        const setup = vi.fn<GerritTerminalGit.GerritTerminalGit["Service"]["setup"]>(
          () => Effect.void,
        );
        const construct = vi.fn(() => ({ setup }));
        using _service = vi
          .spyOn(GerritTerminalGit, "layer", "get")
          .mockReturnValue(Layer.sync(GerritTerminalGit.GerritTerminalGit, construct));
        const invoke = (
          args: string[],
          environment: Record<string, string> = { T3CODE_HOME: beta },
        ) =>
          Command.runWith(makeCli(), { version: "0.0.0" })([
            "gerrit",
            "copy-terminal-credential",
            "--installation",
            "https://review.example/",
            "--environment-id",
            "env-1",
            "--remote",
            "upstream",
            ...args,
          ]).pipe(
            Effect.result,
            Effect.provideService(HostProcess.HomeDirectory, home),
            Effect.provideService(HostProcess.Environment, environment),
            Effect.provideService(HostProcess.WorkingDirectory, home),
            Effect.provide(Layer.merge(NodeCrypto.layer, NetService.layer)),
          );
        for (const args of [
          [],
          ["--base-dir", official],
          ["--base-dir", alias],
          ["--base-dir", ""],
        ]) {
          expect((yield* invoke(args))._tag).toBe("Failure");
        }
        expect((yield* invoke([], {}))._tag).toBe("Failure");
        const nested = path.join(beta, "userdata", "secrets");
        yield* fs.makeDirectory(path.dirname(nested));
        yield* fs.symlink(official, nested);
        expect((yield* invoke(["--base-dir", beta]))._tag).toBe("Failure");
        expect(setup).not.toHaveBeenCalled();
        expect(construct).not.toHaveBeenCalled();
        expect(yield* fs.readLink(nested)).toBe(official);
        yield* fs.remove(nested);
        expect((yield* invoke(["--base-dir", beta]))._tag).toBe("Success");
        expect(setup).toHaveBeenCalledExactlyOnceWith({
          installation: "https://review.example/",
          environmentId: "env-1",
          remote: "upstream",
          baseDir: beta,
          cwd: home,
        });
        expect(yield* fs.readDirectory(official)).toEqual(["sentinel"]);
        expect(yield* fs.readFileString(path.join(official, "sentinel"))).toBe("unchanged");
      }),
  );

  it.effect.each([
    ["install"],
    ["update", "9.0.0"],
    ["service", "install"],
    ["service", "update"],
    ["up"],
    ["app"],
    ["uninstall"],
    ["__service-launcher"],
  ])("rejects unsafe CLI invocation %j before resolving runtime services", (args) =>
    Effect.gen(function* () {
      const result = yield* Command.runWith(makeCli(), { version: "0.0.0" })(args).pipe(
        Effect.result,
        Effect.provide(Layer.merge(NodeCrypto.layer, NetService.layer)),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
