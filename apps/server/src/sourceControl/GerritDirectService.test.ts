// @effect-diagnostics-next-line nodeBuiltinImport:off -- The upload fixture runs Git against a local bare repository.
import * as NodeChildProcess from "node:child_process";
import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as FileSystem from "effect/FileSystem";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { GerritInstallationId, GerritReadError } from "@t3tools/contracts";
import * as GerritHttp from "@t3tools/source-control-gerrit/server/GerritHttp";
import * as GerritRemotes from "@t3tools/source-control-gerrit/server/GerritRemotes";
import {
  resolveRemoteEndpoint,
  selectRemoteBinding,
} from "@t3tools/source-control-gerrit/server/remoteBinding";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Target from "./GerritTarget.ts";
import * as Upload from "./GerritDirectUpload.ts";
import * as Direct from "./GerritDirectService.ts";
import * as GerritWatchCompletion from "./GerritWatchCompletion.ts";

const server = GerritInstallationId.make("https://review.example/");
const config = { installation: server, authMode: "http-basic" as const, bindings: [] };
const change = {
  status: "NEW",
  number: 12,
  key: { installation: server, project: "repo", branch: "main", changeId: `I${"a".repeat(40)}` },
};
const fixture = (
  options: {
    urls?: string[];
    failReread?: boolean;
    realUpload?: boolean;
    status?: string;
    writeStatus?: string;
  } = {},
) => {
  const writes: { path: string; body: unknown }[] = [];
  let reads = 0;
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerSettings.ServerSettingsService, {
      getSettings: Effect.succeed({ gerritConnections: { [server]: config } }),
    } as never),
    Layer.succeed(ServerSecretStore.ServerSecretStore, {
      get: (name: string) =>
        name === "gerrit-gpg-signing-passphrase"
          ? Effect.succeedNone
          : Effect.succeedSome(new TextEncoder().encode('{"username":"user","token":"secret"}')),
    } as never),
    Layer.succeed(Digest.Digest, { digest: () => Effect.succeed(new Uint8Array([1])) } as never),
    Layer.succeed(GerritHttp.GerritHttp, {
      getChangeByNumber: () => {
        reads++;
        return options.failReread && writes.length > 0
          ? Effect.fail(new GerritReadError({ reason: "offline" }))
          : Effect.succeed({ ...change, status: options.status ?? change.status });
      },
      directWrite: (_auth: unknown, path: string, _schema: unknown, write: { body: unknown }) => {
        writes.push({ path, body: write.body });
        return Effect.succeed(
          path.endsWith("topic")
            ? "topic"
            : path.endsWith("review")
              ? { labels: { "Code-Review": 2 } }
              : {
                  _number: 12,
                  project: "repo",
                  branch: "main",
                  status: options.writeStatus ?? "MERGED",
                },
        );
      },
    } as never),
    Layer.succeed(GerritRemotes.GerritRemotes, {
      discover: ({
        configuration,
      }: Parameters<GerritRemotes.GerritRemotes["Service"]["discover"]>[0]) => {
        const remotes = (options.urls ?? [`${server}repo`]).map((url, index) => {
          const endpoint = resolveRemoteEndpoint(url, configuration);
          return {
            name: `remote${index}`,
            configured: { fetch: [endpoint], push: [endpoint] },
            effective: { fetch: [endpoint], push: [endpoint] },
          };
        });
        return Effect.succeed({
          remotes,
          upstream: { kind: "unsupported" },
          binding: selectRemoteBinding({ remotes }),
        });
      },
    } as never),
    ...(options.realUpload
      ? []
      : [
          Layer.succeed(Upload.GerritDirectUpload, {
            upload: () => Effect.succeed({ pushed: true }),
          } as never),
        ]),
  );
  const host = Layer.unwrap(
    Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      return TestSourceControlHost.layer({ process: { run: process.run } });
    }),
  ).pipe(Layer.provideMerge(VcsProcess.layer), Layer.provideMerge(NodeServices.layer));
  const target = Target.layer.pipe(Layer.provideMerge(dependencies));
  const layers = options.realUpload
    ? Layer.merge(target, Upload.layer.pipe(Layer.provideMerge(Layer.merge(host, dependencies))))
    : target;
  return { writes, getReads: () => reads, layer: Direct.layer.pipe(Layer.provide(layers)), host };
};

it.effect("writes a topic against the number resolved from the checkout", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* Direct.GerritDirectService;
    const result = yield* service.act({
      cwd: "/repo",
      target: { number: 12 },
      action: { kind: "topic", topic: "topic" },
    });
    expect(result.change).toEqual(change);
    expect(f.writes).toEqual([{ path: "changes/12/topic", body: { topic: "topic" } }]);
    expect(f.getReads()).toBe(3);
  }).pipe(Effect.provide(f.layer));
});
it.effect("writes a review vote using a URL target", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* Direct.GerritDirectService;
    yield* service.act({
      cwd: "/repo",
      target: { url: `${server}c/repo/+/12` },
      action: { kind: "review", labels: { "Code-Review": 2 } },
      notify: "NONE",
    });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.path).toBe("changes/12/revisions/current/review");
    expect(f.writes[0]?.body).toMatchObject({ labels: { "Code-Review": 2 }, notify: "NONE" });
  }).pipe(Effect.provide(f.layer));
});
it.effect.each([
  { operation: "submit", status: "MERGED", success: true },
  { operation: "abandon", status: "ABANDONED", success: true },
  { operation: "submit", status: "ABANDONED", success: false },
  { operation: "abandon", status: "MERGED", success: false },
] as const)(
  "records only confirmed $operation provenance ($status)",
  ({ operation, status, success }) => {
    const f = fixture({ writeStatus: status, failReread: true });
    return Effect.gen(function* () {
      const service = yield* Direct.GerritDirectService;
      const completed: unknown[] = [];
      const result = yield* Effect.result(
        service.act({ cwd: "/repo", target: { number: 12 }, action: { kind: operation } }).pipe(
          Effect.provideService(GerritWatchCompletion.NativeAction, (action, write) =>
            write.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  completed.push(action);
                }),
              ),
            ),
          ),
        ),
      );
      expect(Result.isSuccess(result)).toBe(success);
      expect(completed).toEqual(
        success ? [{ server, project: "repo", number: 12, operation }] : [],
      );
      if (Result.isSuccess(result)) expect(result.success.change).toBeNull();
      expect(f.writes[0]?.path).toBe(`changes/12/${operation}`);
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect("rejects ambiguous checkout remotes", () => {
  const f = fixture({ urls: [`${server}repo`, `${server}other`] });
  return Effect.gen(function* () {
    const service = yield* Direct.GerritDirectService;
    const result = yield* Effect.result(
      service.act({ cwd: "/repo", target: { number: 12 }, action: { kind: "submit" } }),
    );
    expect(Result.isFailure(result) && result.failure.reason).toBe("target");
    expect(f.writes).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});
it.effect("uploads a new change to the matched remote", () => {
  const f = fixture({ realUpload: true });
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gerrit-direct-service-" });
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
    git("init", "--initial-branch=main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("commit", "--allow-empty", "-m", `Subject\n\nChange-Id: I${"a".repeat(40)}`);
    git("init", "--bare", "receiver");
    git("remote", "add", "remote0", `${cwd}/receiver`);
    const service = yield* Direct.GerritDirectService;
    const result = yield* service.upload({ cwd, upload: { kind: "new", branch: "main" } });
    expect(result).toEqual({ result: { pushed: true }, change: null });
    expect(git("--git-dir=receiver", "for-each-ref", "--format=%(refname)")).toContain(
      "refs/for/main%no-publish-comments",
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(f.layer, f.host)));
});
it.effect("preserves the successful result when the re-read fails", () => {
  const f = fixture({ failReread: true });
  return Effect.gen(function* () {
    const service = yield* Direct.GerritDirectService;
    const result = yield* service.act({
      cwd: "/repo",
      target: { number: 12 },
      action: { kind: "topic", topic: "topic" },
    });
    expect(result.change).toBeNull();
    expect(result.rereadError).toBeDefined();
    expect(f.writes).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("refuses review actions on a merged or abandoned change before writing", () =>
  Effect.gen(function* () {
    for (const status of ["MERGED", "ABANDONED"]) {
      const f = fixture({ status });
      const error = yield* Effect.gen(function* () {
        const service = yield* Direct.GerritDirectService;
        return yield* service
          .act({
            cwd: "/repo",
            target: { number: 12 },
            action: {
              kind: "review",
              message: "late",
              comments: [{ path: "a.txt", line: 3, message: "inline" }],
            },
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(f.layer));
      expect(error).toMatchObject({ _tag: "GerritDirectError", reason: "closed" });
      expect(f.writes).toEqual([]);
    }
  }),
);
