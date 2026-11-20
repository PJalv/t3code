import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GerritInstallationId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as GerritTerminalGit from "./GerritTerminalGit.ts";
import { terminalGitConfig, terminalGitTarget } from "./gerritTerminalGitPolicy.ts";

const installation = GerritInstallationId.make("https://review.example/gerrit/");
const url = `${installation}a/team/repo`;
const helper = "/system/git-credential-libsecret";
const config = `credential.helper\n${helper}\0credential.usehttppath\ntrue\0credential.${url}.username\nalice\0`;

it.live("matches real Git credential paths and rejects paths Git would normalize", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const env = yield* HostProcess.Environment;
    const cwd = yield* fs.makeTempDirectoryScoped();
    for (const [remote, expectedPath] of [
      [url, "gerrit/a/team/repo"],
      [`${url}/`, "gerrit/a/team/repo"],
      [`${url}?`, "gerrit/a/team/repo?"],
      [`${url}#`, "gerrit/a/team/repo#"],
      [`${url}?#`, "gerrit/a/team/repo?#"],
      ["https://review.example///gerrit/a/team/repo", "gerrit/a/team/repo"],
    ] as const) {
      // Only this process sees the synthetic helper; it echoes Git's input without accessing storage.
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "git",
          [
            "-c",
            "credential.helper=",
            "-c",
            "credential.helper=!f() { while IFS= read -r line && test -n \"$line\"; do printf '%s\\n' \"$line\" >&2; done; printf 'username=synthetic\\npassword=synthetic\\n'; }; f",
            "-c",
            "credential.useHttpPath=true",
            "credential",
            "fill",
          ],
          {
            cwd,
            extendEnv: false,
            env: {
              PATH: env.PATH,
              HOME: cwd,
              XDG_CONFIG_HOME: cwd,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_TERMINAL_PROMPT: "0",
            },
            stdin: Stream.succeed(new TextEncoder().encode(`url=${remote}\n\n`)),
          },
        ),
      );
      const [protocol, , code] = yield* Effect.all(
        [
          child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          child.stdout.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      expect(code).toBe(0);
      expect(protocol.split("\n")).toContain(`path=${expectedPath}`);
      if (remote === url) expect(terminalGitTarget(installation, remote).path).toBe(expectedPath);
      else expect(() => terminalGitTarget("https://review.example/", remote)).toThrow();
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("scopes credentials to the exact HTTPS repository, proxy path, port and account", () => {
  const target = terminalGitTarget(installation, url);
  expect(target).toEqual({ url, host: "review.example", path: "gerrit/a/team/repo" });
  expect(terminalGitConfig(config, target)).toEqual({ helper, username: "alice" });
  expect(
    terminalGitTarget(
      "https://review.example:8443/gerrit/",
      "https://review.example:8443/gerrit/a/repo",
    ).host,
  ).toBe("review.example:8443");
  for (const remote of [
    "ssh://review.example/repo",
    "http://review.example/gerrit/repo",
    "https://other.example/gerrit/repo",
    "https://review.example/gerrit-other/repo",
    "https://review.example/gerrit/",
    "https://alice:password@review.example/gerrit/repo",
    `${url}?token=secret`,
    `${url}#fragment`,
    `${url}%0a`,
    `${url}/../repo`,
    `${url}\n${url}`,
  ]) {
    expect(() => terminalGitTarget(installation, remote)).toThrow();
  }
});

it("reports the failed prerequisite without returning raw configuration", () => {
  const target = terminalGitTarget(installation, url);
  for (const [raw, reason] of [
    [config.replace(helper, ""), "helper-config"],
    [config.replace(helper, "store --file=/synthetic-secret"), "helper-config"],
    [`${config}credential.helper\nstore\0`, "helper-chain"],
    [config.replace("true", "false"), "path-matching"],
    [config.replace(`credential.${url}.username\nalice\0`, ""), "username"],
    [`${config}credential.https://other.example/.helper\nstore\0`, "credential-rules"],
  ] as const) {
    try {
      terminalGitConfig(raw, target);
      expect.fail("Expected prerequisite rejection");
    } catch (error) {
      expect(error).toMatchObject({ reason });
      expect(String(error)).not.toContain("synthetic-secret");
    }
  }
});

it("rejects helper chains, shell injection, plaintext fallback, and ambiguous credential rules", () => {
  const target = terminalGitTarget(installation, url);
  for (const unsafe of [
    config.replace(helper, "store"),
    config.replace(helper, "cache"),
    config.replace(helper, "manager"),
    config.replace(helper, "libsecret"),
    config.replace(helper, `${helper} --option`),
    config.replace(helper, "!echo password=secret"),
    config.replace(helper, `${helper};echo bad`),
    `${config}credential.helper\nstore\0`,
    `${config}credential.helper\n${helper}\0`,
    `${config}credential.https://unrelated.example/.helper\nstore\0`,
    config.replace("credential.usehttppath", `credential.${url}.usehttppath`),
    config.replace("true", "false"),
    config.replace(`credential.${url}.username`, "credential.username"),
    `${config}url.https://other.example/.insteadof\nhttps://review.example/\0`,
    config.replace("alice", "alice\npassword=injected"),
    config.slice(0, -1),
  ])
    expect(() => terminalGitConfig(unsafe, target)).toThrow();
  expect(terminalGitConfig(`credential.helper\n\0${config}`, target)).toEqual({
    helper,
    username: "alice",
  });
});

const exercise = Effect.fn("test.terminalGit")(function* (options: {
  readonly platform?: NodeJS.Platform;
  readonly environmentId?: string;
  readonly owner?: number;
  readonly credential?: { username: string; token: string };
  readonly config?: string;
  readonly exitCode?: number;
  readonly helperOwner?: number;
  readonly gitOverride?: boolean;
  readonly remote?: string;
  readonly push?: string;
  readonly globalPathMissing?: boolean;
  readonly globalPathAbsent?: boolean;
  readonly changedConfig?: boolean;
  readonly invalidSecret?: boolean;
}) {
  const realFs = yield* FileSystem.FileSystem;
  const directory = yield* realFs.makeTempDirectoryScoped();
  const executable = `${directory}/fixture`;
  yield* realFs.writeFile(executable, new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
  yield* realFs.chmod(executable, 0o755);
  const stat = yield* realFs.stat(executable);
  let reads = 0;
  let configReads = 0;
  let stores = 0;
  let delivered = "";
  const credential = options.credential ?? { username: "alice", token: "synthetic-secret" };
  const fs = FileSystem.makeNoop({
    exists: () => Effect.succeed(true),
    realPath: (name) => Effect.succeed(name),
    stat: (name) =>
      Effect.succeed({
        ...stat,
        type: name === helper || name === "/system/git" ? "File" : "Directory",
        uid: Option.some(
          name === "/home/test/.t3/userdata" ? (options.owner ?? 1000) : (options.helperOwner ?? 0),
        ),
      }),
    open: () => realFs.open(executable),
    readFileString: (name) =>
      Effect.succeed(
        name.endsWith("environment-id")
          ? "environment-1"
          : JSON.stringify({
              gerritConnections: {
                [installation]: { installation, authMode: "http-basic", bindings: [] },
              },
            }),
      ),
    readFile: () =>
      Effect.sync(() => {
        reads++;
        return new TextEncoder().encode(
          options.invalidSecret ? "synthetic-secret" : JSON.stringify(credential),
        );
      }),
  });
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
      expect(JSON.stringify(command.args)).not.toContain(credential.token);
      expect(JSON.stringify(command.options.env)).not.toContain(credential.token);
      let stdout = "";
      if (command.command === helper) {
        stores++;
        expect(command.args).toEqual(["store"]);
        expect(command.options.stdout).toBe("ignore");
        expect(command.options.stderr).toBe("ignore");
        expect(command.options.extendEnv).toBe(false);
        const stdin = command.options.stdin;
        if (!Stream.isStream(stdin)) return yield* Effect.die("Expected stdin stream");
        delivered = yield* stdin.pipe(Stream.decodeText(), Stream.mkString);
      } else {
        expect(command.command).toBe("/system/git");
        if (command.args.includes("--list")) configReads++;
        stdout = command.args.includes("--global")
          ? options.globalPathMissing
            ? "false\n"
            : "true\n"
          : command.args[0] === "config"
            ? `${options.config ?? config}${options.changedConfig && configReads > 1 ? "core.bare\nfalse\0" : ""}`
            : `${command.args.includes("--push") ? (options.push ?? options.remote ?? url) : (options.remote ?? url)}\n`;
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        stdout: Stream.succeed(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        stdin: Sink.drain,
        exitCode: Effect.succeed(
          ChildProcessSpawner.ExitCode(
            command.command === helper
              ? (options.exitCode ?? 0)
              : command.args.includes("--global") && options.globalPathAbsent
                ? 1
                : 0,
          ),
        ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const result = yield* Effect.gen(function* () {
    const service = yield* GerritTerminalGit.GerritTerminalGit;
    return yield* service.setup({
      installation,
      environmentId: options.environmentId ?? "environment-1",
      baseDir: "/home/test/.t3",
      cwd: "/checkout",
      remote: "origin",
    });
  }).pipe(
    Effect.provide(GerritTerminalGit.layer),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcess.Platform, options.platform ?? "linux"),
    Effect.provideService(HostProcess.UserId, 1000),
    Effect.provideService(HostProcess.Environment, {
      PATH: "/system",
      HOME: "/home/test",
      ...(options.gitOverride ? { GIT_CONFIG_COUNT: "1" } : {}),
    }),
    Effect.result,
  );
  return { result, reads, stores, delivered };
}, Effect.scoped);

it.effect(
  "delivers the credential only through stdin and does not change config, secrets, or remotes",
  () =>
    Effect.gen(function* () {
      const result = yield* exercise({});
      expect(result.result._tag).toBe("Success");
      expect(result.reads).toBe(1);
      expect(result.stores).toBe(1);
      expect(result.delivered).toBe(
        "protocol=https\nhost=review.example\npath=gerrit/a/team/repo\nusername=alice\npassword=synthetic-secret\n\n",
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "fails before reading secrets on unsupported platforms, wrong environment, unsafe helpers and remotes",
  () =>
    Effect.gen(function* () {
      for (const options of [
        { platform: "win32" as const },
        { platform: "darwin" as const },
        { environmentId: "wrong" },
        { owner: 2000 },
        { gitOverride: true },
        { helperOwner: 1000 },
        { config: config.replace(helper, "store") },
        { remote: "ssh://review.example/repo" },
        { remote: `${url}/` },
        { remote: `${url}?` },
        { remote: `${url}#` },
        { remote: `${url}?#` },
        { remote: "https://review.example///gerrit/a/team/repo" },
        { remote: `${installation}a//team/repo` },
        { push: `${url}-other` },
        { changedConfig: true },
        { globalPathMissing: true },
        { globalPathAbsent: true },
      ]) {
        const result = yield* exercise(options);
        expect(result.result._tag).toBe("Failure");
        expect(result.reads).toBe(0);
        expect(result.stores).toBe(0);
        if ("globalPathMissing" in options || "globalPathAbsent" in options) {
          expect(result.result).toMatchObject({
            _tag: "Failure",
            failure: { reason: "path-matching" },
          });
        }
      }
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "rejects account mismatch and protocol injection and returns only safe helper failure diagnostics",
  () =>
    Effect.gen(function* () {
      for (const credential of [
        { username: "bob", token: "synthetic-secret" },
        { username: "alice", token: "synthetic-secret\nurl=https://evil" },
      ]) {
        const result = yield* exercise({ credential });
        expect(result.result._tag).toBe("Failure");
        expect(result.stores).toBe(0);
        expect(JSON.stringify(result.result)).not.toContain(credential.token);
      }
      const invalid = yield* exercise({ invalidSecret: true });
      expect(invalid.result._tag).toBe("Failure");
      expect(invalid.stores).toBe(0);
      expect(JSON.stringify(invalid.result)).not.toContain("synthetic-secret");
      const result = yield* exercise({ exitCode: 1 });
      expect(result.result._tag).toBe("Failure");
      expect(result.stores).toBe(1);
      expect(JSON.stringify(result.result)).not.toContain("synthetic-secret");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
