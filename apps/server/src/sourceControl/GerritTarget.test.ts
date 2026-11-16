import { it, describe, expect } from "@effect/vitest";
import { GerritInstallationId } from "@t3tools/contracts";
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
import * as GerritTarget from "./GerritTarget.ts";

const server = GerritInstallationId.make("https://review.example:8443/gerrit/");
const config = {
  installation: server,
  authMode: "http-basic" as const,
  bindings: [],
  sshHost: { host: "ssh.example", port: 29418 },
};
const fixture = (urls: string[], extra = [] as (typeof config)[], project = "team/repo") => {
  const configs = [config, ...extra];
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerSettings.ServerSettingsService, {
      getSettings: Effect.succeed({
        gerritConnections: Object.fromEntries(configs.map((c) => [c.installation, c])),
      }),
    } as never),
    Layer.succeed(ServerSecretStore.ServerSecretStore, {
      get: () =>
        Effect.succeedSome(new TextEncoder().encode('{"username":"user","token":"secret"}')),
    } as never),
    Layer.succeed(Digest.Digest, { digest: () => Effect.succeed(new Uint8Array([1])) } as never),
    Layer.succeed(GerritHttp.GerritHttp, {
      getChangeByNumber: () => Effect.succeed({ key: { project, branch: "main" } }),
    } as never),
    Layer.succeed(GerritRemotes.GerritRemotes, {
      discover: ({
        configuration,
      }: Parameters<GerritRemotes.GerritRemotes["Service"]["discover"]>[0]) => {
        const remotes = urls.map((url, index) => {
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
  );
  return GerritTarget.layer.pipe(Layer.provide(dependencies));
};

describe("GerritTarget", () => {
  it.effect("resolves HTTPS path and port without an upstream and reads a number", () =>
    Effect.gen(function* () {
      const target = yield* GerritTarget.GerritTarget;
      expect(yield* target.resolve({ cwd: "/repo" })).toEqual({ server, project: "team/repo" });
      expect(yield* target.resolve({ cwd: "/repo", number: 12 })).toEqual({
        server,
        project: "team/repo",
        number: 12,
        branch: "main",
      });
    }).pipe(Effect.provide(fixture([`${server}team/repo`]))),
  );
  it.effect("maps an SSH host and supports legacy change URLs", () =>
    Effect.gen(function* () {
      const target = yield* GerritTarget.GerritTarget;
      expect(yield* target.resolve({ cwd: "/repo", url: `${server}#/c/12` })).toEqual({
        server,
        project: "team/repo",
        number: 12,
        branch: "main",
      });
    }).pipe(Effect.provide(fixture(["ssh://git@ssh.example:29418/team/repo"]))),
  );
  it.effect("rejects mismatches and unconfigured hosts", () =>
    Effect.gen(function* () {
      const target = yield* GerritTarget.GerritTarget;
      const mismatch = yield* Effect.result(
        target.resolve({ cwd: "/repo", url: `${server}c/other/+/12` }),
      );
      expect(Result.isFailure(mismatch) && mismatch.failure.reason).toBe("project-mismatch");
      const unconfigured = yield* Effect.result(
        target.resolve({ url: "https://evil.example/c/team/repo/+/12" }),
      );
      expect(Result.isFailure(unconfigured) && unconfigured.failure.reason).toBe("invalid-url");
      const wrongChange = yield* Effect.result(target.resolve({ cwd: "/repo", number: 12 }));
      expect(Result.isFailure(wrongChange) && wrongChange.failure.reason).toBe("project-mismatch");
    }).pipe(Effect.provide(fixture([`${server}team/repo`], [], "other"))),
  );
  it.effect("rejects multiple remotes and ambiguous SSH mapping", () =>
    Effect.gen(function* () {
      const target = yield* GerritTarget.GerritTarget;
      const result = yield* Effect.result(target.resolve({ cwd: "/repo" }));
      expect(Result.isFailure(result) && result.failure.reason).toBe("ambiguous-remote");
    }).pipe(
      Effect.provide(
        fixture(
          ["ssh://git@ssh.example:29418/team/repo"],
          [{ ...config, installation: GerritInstallationId.make("https://other.example/") }],
        ),
      ),
    ),
  );
  it.effect("does not guess a sole server for an unrelated checkout", () =>
    Effect.gen(function* () {
      const target = yield* GerritTarget.GerritTarget;
      const result = yield* Effect.result(target.resolve({ cwd: "/repo" }));
      expect(Result.isFailure(result) && result.failure.reason).toBe("remote-not-configured");
    }).pipe(Effect.provide(fixture(["https://elsewhere.example/team/repo"]))),
  );
  it.effect("rejects overlapping configured URL prefixes", () =>
    Effect.gen(function* () {
      const target = yield* GerritTarget.GerritTarget;
      const result = yield* Effect.result(target.resolve({ url: `${server}c/team/repo/+/12` }));
      expect(Result.isFailure(result) && result.failure.reason).toBe("ambiguous-server");
    }).pipe(
      Effect.provide(
        fixture(
          [],
          [{ ...config, installation: GerritInstallationId.make("https://review.example:8443/") }],
        ),
      ),
    ),
  );
  it.effect("rejects different repositories on multiple remotes", () =>
    Effect.gen(function* () {
      const target = yield* GerritTarget.GerritTarget;
      const result = yield* Effect.result(target.resolve({ cwd: "/repo" }));
      expect(Result.isFailure(result) && result.failure.reason).toBe("ambiguous-remote");
    }).pipe(Effect.provide(fixture([`${server}team/repo`, `${server}team/other`]))),
  );
});
