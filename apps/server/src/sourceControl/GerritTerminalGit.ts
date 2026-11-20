import { GerritConnectionConfig, type GerritInstallationId } from "@t3tools/contracts";
import * as GerritHttp from "@t3tools/source-control-gerrit/server/GerritHttp";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { deriveServerPaths } from "../config.ts";
import { credentialSecretName } from "./gerritBranchReviews.ts";
import {
  GerritTerminalGitError,
  terminalGitConfig,
  terminalGitTarget,
} from "./gerritTerminalGitPolicy.ts";

export class GerritTerminalGit extends Context.Service<
  GerritTerminalGit,
  {
    readonly setup: (input: {
      readonly installation: GerritInstallationId;
      readonly environmentId: string;
      readonly baseDir: string;
      readonly cwd: string;
      readonly remote: string;
    }) => Effect.Effect<void, GerritTerminalGitError>;
  }
>()("t3/sourceControl/GerritTerminalGit") {}

const isSetupError = Schema.is(GerritTerminalGitError);
const decodeSettings = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      gerritConnections: Schema.Record(Schema.String, GerritConnectionConfig),
    }),
  ),
);
const decodeCredential = Schema.decodeEffect(
  Schema.fromJsonString(GerritHttp.GerritHttpCredentialValue),
);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const digest = yield* Digest.Digest;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const uid = yield* HostProcess.UserId;
  const env = Object.fromEntries(
    ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap(
      (key) => (environment[key] === undefined ? [] : [[key, environment[key]]]),
    ),
  );
  const trustedExecutable = Effect.fn("GerritTerminalGit.trustedExecutable")(
    function* (name: string) {
      const canonical = yield* fs.realPath(name);
      let current = canonical;
      while (true) {
        const stat = yield* fs.stat(current);
        if (
          Option.getOrUndefined(stat.uid) !== 0 ||
          ((stat.mode & 0o022) !== 0 &&
            !(
              current === "/nix/store" &&
              stat.type === "Directory" &&
              (stat.mode & 0o1000) !== 0 &&
              (stat.mode & 0o002) === 0
            ))
        ) {
          return yield* new GerritTerminalGitError({ reason: "helper" });
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      const file = yield* fs.open(canonical, { flag: "r" });
      const stat = yield* file.stat;
      const header = yield* file.readAlloc(4);
      if (
        stat.type !== "File" ||
        (stat.mode & 0o111) === 0 ||
        Option.isNone(header) ||
        !Buffer.from(header.value).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      ) {
        return yield* new GerritTerminalGitError({ reason: "helper" });
      }
      return canonical;
    },
    Effect.scoped,
    Effect.mapError(() => new GerritTerminalGitError({ reason: "helper" })),
  );

  const setup: GerritTerminalGit["Service"]["setup"] = Effect.fn("GerritTerminalGit.setup")(
    function* (input) {
      if (platform !== "linux") return yield* new GerritTerminalGitError({ reason: "platform" });
      if (
        uid === undefined ||
        uid === 0 ||
        Object.keys(environment).some((key) => key.startsWith("GIT_"))
      ) {
        return yield* new GerritTerminalGitError({ reason: "environment" });
      }
      const paths = yield* deriveServerPaths(input.baseDir, undefined, { baseDirIsExplicit: true });
      const owner = yield* fs.stat(paths.stateDir);
      if (
        Option.getOrUndefined(owner.uid) !== uid ||
        (yield* fs.readFileString(paths.environmentIdPath)).trim() !== input.environmentId
      ) {
        return yield* new GerritTerminalGitError({ reason: "environment" });
      }
      const settings = yield* decodeSettings(yield* fs.readFileString(paths.settingsPath)).pipe(
        Effect.mapError(() => new GerritTerminalGitError({ reason: "connection" })),
      );
      const connection = settings.gerritConnections[input.installation];
      if (connection?.installation !== input.installation || connection.authMode !== "http-basic") {
        return yield* new GerritTerminalGitError({ reason: "connection" });
      }
      const candidates = (env.PATH ?? "").split(path.sep === "/" ? ":" : ";");
      if (candidates.some((dir) => !path.isAbsolute(dir))) {
        return yield* new GerritTerminalGitError({ reason: "helper" });
      }
      let git: string | undefined;
      for (const dir of candidates) {
        const candidate = path.join(dir, "git");
        if (yield* fs.exists(candidate)) {
          git = yield* trustedExecutable(candidate);
          break;
        }
      }
      if (!git) return yield* new GerritTerminalGitError({ reason: "helper" });
      const readGit = Effect.fn("GerritTerminalGit.readGit")(
        function* (args: string[]) {
          const child = yield* spawner.spawn(
            ChildProcess.make(git, args, {
              cwd: input.cwd,
              env,
              extendEnv: false,
              stdin: "ignore",
              stderr: "ignore",
            }),
          );
          const [output, code] = yield* Effect.all(
            [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
            { concurrency: "unbounded" },
          );
          if (code !== 0 || output.length > 1024 * 1024)
            return yield* new GerritTerminalGitError({ reason: "config" });
          return output;
        },
        Effect.scoped,
        Effect.timeout("10 seconds"),
      );
      if (
        (yield* readGit([
          "config",
          "--global",
          "--type=bool",
          "--get",
          "credential.useHttpPath",
        ]).pipe(
          Effect.mapError(() => new GerritTerminalGitError({ reason: "path-matching" })),
        )).trim() !== "true"
      ) {
        return yield* new GerritTerminalGitError({ reason: "path-matching" });
      }
      const rawConfig = yield* readGit(["config", "--null", "--list", "--includes"]);
      const fetch = (yield* readGit(["remote", "get-url", "--all", input.remote])).trim();
      const push = (yield* readGit(["remote", "get-url", "--push", "--all", input.remote])).trim();
      if (fetch !== push || fetch.includes("\n"))
        return yield* new GerritTerminalGitError({ reason: "remote" });
      const target = yield* Effect.try({
        try: () => terminalGitTarget(input.installation, fetch),
        catch: () => new GerritTerminalGitError({ reason: "remote" }),
      });
      if (
        Object.keys(settings.gerritConnections).some(
          (other) =>
            other !== input.installation &&
            other.startsWith(input.installation) &&
            target.url.startsWith(other),
        )
      ) {
        return yield* new GerritTerminalGitError({ reason: "remote" });
      }
      const config = yield* Effect.try({
        try: () => terminalGitConfig(rawConfig, target),
        catch: (error) =>
          isSetupError(error) ? error : new GerritTerminalGitError({ reason: "config" }),
      });
      const helper = yield* trustedExecutable(config.helper);
      if (path.basename(helper) !== "git-credential-libsecret") {
        return yield* new GerritTerminalGitError({ reason: "helper" });
      }
      // Do not sync against a config or remote that changed while validating the helper.
      if (
        rawConfig !== (yield* readGit(["config", "--null", "--list", "--includes"])) ||
        fetch !== (yield* readGit(["remote", "get-url", "--all", input.remote])).trim() ||
        push !== (yield* readGit(["remote", "get-url", "--push", "--all", input.remote])).trim()
      ) {
        return yield* new GerritTerminalGitError({ reason: "config" });
      }
      const secretName = yield* credentialSecretName(digest, input.installation);
      const secret = yield* ServerSecretStore.readFromDirectory(paths.secretsDir, secretName);
      if (Option.isNone(secret)) return yield* new GerritTerminalGitError({ reason: "connection" });
      const credential = yield* decodeCredential(new TextDecoder().decode(secret.value)).pipe(
        Effect.mapError(() => new GerritTerminalGitError({ reason: "credential" })),
      );
      if (credential.username !== config.username || /[\x00-\x1f\x7f]/.test(credential.token)) {
        return yield* new GerritTerminalGitError({ reason: "credential" });
      }
      // libsecret echoes the password even for store. Never capture or inherit either output stream.
      const stored = yield* spawner
        .exitCode(
          ChildProcess.make(helper, ["store"], {
            cwd: "/",
            env,
            extendEnv: false,
            stdout: "ignore",
            stderr: "ignore",
            stdin: Stream.succeed(
              new TextEncoder().encode(
                `protocol=https\nhost=${target.host}\npath=${target.path}\nusername=${credential.username}\npassword=${credential.token}\n\n`,
              ),
            ),
          }),
        )
        .pipe(
          Effect.timeout("60 seconds"),
          Effect.mapError(() => new GerritTerminalGitError({ reason: "store" })),
        );
      if (stored !== 0) return yield* new GerritTerminalGitError({ reason: "store" });
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.mapError((error) =>
      isSetupError(error) ? error : new GerritTerminalGitError({ reason: "environment" }),
    ),
  );

  return GerritTerminalGit.of({ setup });
});
export const layer = Layer.effect(GerritTerminalGit, make);
