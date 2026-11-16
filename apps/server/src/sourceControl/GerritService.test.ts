// @effect-diagnostics-next-line nodeBuiltinImport:off -- A loopback fixture exercises authenticated reads without live Gerrit.
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as GerritHttp from "@t3tools/source-control-gerrit/server/GerritHttp";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpServerRequest } from "effect/http";
import * as SessionStore from "../auth/SessionStore.ts";
import {
  EnvironmentId,
  GerritConnectionConfig,
  GerritInstallationId,
  GerritProjectName,
  GerritRepositoryScope,
  GitCommitOid,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as GerritLocalCommits from "@t3tools/source-control-gerrit/server/GerritLocalCommits";
import {
  commitIdentity,
  mapLocalCommits,
} from "@t3tools/source-control-gerrit/server/localCommitMapping";
import * as GerritRemotes from "@t3tools/source-control-gerrit/server/GerritRemotes";
import {
  GerritRemoteTargetBranch,
  gerritRemoteConfiguration,
  resolveRemoteEndpoint,
} from "@t3tools/source-control-gerrit/server/remoteBinding";
import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitHttpAuth from "../vcs/GitHttpAuth.ts";
import * as GerritGitHttpAuth from "./GerritGitHttpAuth.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";
import * as GerritService from "./GerritService.ts";
import * as BuiltInDrivers from "./builtInDrivers.ts";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

const privateAmendBarrier = vi.hoisted(() => ({
  onSpawn: undefined as ((child: import("node:child_process").ChildProcess) => void) | undefined,
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
      if (
        args[0] === "/proc/self/fd/3" &&
        Array.isArray(args[1]) &&
        args[1].includes("hash-object")
      )
        privateAmendBarrier.onSpawn?.(child);
      return child;
    }) as typeof original.spawn,
  };
});

const decodeGerritInstallationId = Schema.decodeEffect(GerritInstallationId);
const decodeGerritConnectionConfig = Schema.decodeEffect(GerritConnectionConfig);
const decodeGerritRepositoryScope = Schema.decodeEffect(GerritRepositoryScope);
const decodeGitCommitOid = Schema.decodeEffect(GitCommitOid);
const isNumberedChange = Schema.is(Schema.Struct({ _number: Schema.Number }));

const hostLayer = ServerSourceControlHost.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsDriverRegistry.layer),
  Layer.provideMerge(VcsProcess.layer),
);
const serviceTestLayer = (
  baseDir: string | { readonly prefix: string } = { prefix: "t3-gerrit-service-" },
  persistence:
    | typeof SqlitePersistence.layerMemory
    | ReturnType<typeof SqlitePersistence.layerFromPath> = SqlitePersistence.layerMemory,
) =>
  GerritService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(GerritLocalCommits.layer, GerritRemotes.layer)),
    Layer.provideMerge(BuiltInDrivers.layer),
    Layer.provideMerge(hostLayer),
    Layer.provideMerge(EnvironmentAuth.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(GerritGitHttpAuth.layer),
    Layer.provideMerge(
      ServerSettings.layer.pipe(
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(Layer.fresh(persistence)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      ),
    ),
    Layer.provideMerge(GerritHttp.layer),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );
const testLayer = serviceTestLayer();
const json = (response: NodeHttp.ServerResponse, value: unknown) => {
  response.setHeader("Content-Type", "application/json");
  response.end(`)]}'\n${JSON.stringify(value)}`);
};
const fixture = Effect.fn("GerritService.test.fixture")(function* () {
  const state: {
    revoked: boolean;
    account: number;
    changes: ReadonlyArray<unknown>;
    requests: string[];
    headers: string[];
    pageFailure: boolean;
    drafts: Record<string, unknown[]>;
    extras: Record<string, unknown>;
    writes: Array<{ path: string; method: string; body: unknown }>;
    failWrite: boolean;
    rebaseConflict: boolean;
    recordReview: boolean;
    holdWrite: ((response: NodeHttp.ServerResponse) => void) | null;
    holdSearch: ((response: NodeHttp.ServerResponse) => void) | null;
    holdDetail: ((response: NodeHttp.ServerResponse, value: unknown) => void) | null;
    hidden: number;
    failProjectSearch: boolean;
    gitHttp:
      | ((request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void)
      | null;
  } = {
    revoked: false,
    account: 42,
    changes: [],
    requests: [],
    headers: [],
    pageFailure: false,
    drafts: {},
    extras: {},
    writes: [],
    failWrite: false,
    rebaseConflict: false,
    recordReview: false,
    holdWrite: null,
    holdSearch: null,
    holdDetail: null,
    hidden: 0,
    failProjectSearch: false,
    gitHttp: null,
  };
  const server = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeHttp.Server>((resolve) => {
          const server = NodeHttp.createServer((request, response) => {
            state.requests.push(request.url ?? "");
            state.headers.push(request.headers.authorization ?? "");
            if (state.gitHttp && /^\/Review\/(?:a\/)?Team\/Repo\//.test(request.url ?? "")) {
              state.gitHttp(request, response);
              return;
            }
            if (state.revoked) {
              response.statusCode = 401;
              response.end("revoked fixture-secret-ONE");
              return;
            }
            if (request.method !== "GET") {
              const chunks: Buffer[] = [];
              request.on("data", (chunk: Buffer) => chunks.push(chunk));
              request.on("end", () => {
                const text = Buffer.concat(chunks).toString();
                state.writes.push({
                  path: request.url ?? "",
                  method: request.method ?? "",
                  body: text ? JSON.parse(text) : null,
                });
                if (state.holdWrite !== null) {
                  state.holdWrite(response);
                  return;
                }
                if (state.failWrite) {
                  response.destroy();
                  return;
                }
                if (state.rebaseConflict && request.url?.endsWith("/rebase")) {
                  response.statusCode = 409;
                  response.end(
                    "Change 1 could not be rebased due to a conflict during merge.\n\nmerge conflict(s):\n* tracked",
                  );
                  return;
                }
                if (state.recordReview && request.url?.endsWith("/review")) {
                  const body = JSON.parse(text) as {
                    comments?: Record<string, Array<Record<string, unknown>>>;
                  };
                  const match = /\/changes\/(\d+)\/revisions\/([0-9a-f]+)\/review/u.exec(
                    request.url ?? "",
                  );
                  const change = state.changes.find(
                    (candidate) =>
                      isNumberedChange(candidate) && candidate._number === Number(match?.[1]),
                  ) as { revisions?: Record<string, { _number: number }> } | undefined;
                  const patchSet =
                    match?.[2] === undefined ? null : change?.revisions?.[match[2]]?._number;
                  const comments = (state.extras.comments ?? {}) as Record<string, unknown[]>;
                  for (const [path, rows] of Object.entries(body.comments ?? {})) {
                    for (const row of rows) {
                      (comments[path] ??= []).push({
                        ...row,
                        id: `published-${Object.values(comments).flat().length + 1}`,
                        patch_set: patchSet ?? 1,
                        updated: "2026-10-01 13:00:00.000000000",
                        author: { _account_id: state.account },
                      });
                    }
                  }
                  state.extras.comments = comments;
                  json(response, { labels: {} });
                  return;
                }
                if (request.url?.includes("/drafts")) {
                  const comment = JSON.parse(text);
                  const characters = Array.from<string>(comment.message);
                  const first = characters.findIndex((character) => character.charCodeAt(0) > 0x20);
                  const last = characters.findLastIndex(
                    (character) => character.charCodeAt(0) > 0x20,
                  );
                  const message = first < 0 ? "" : characters.slice(first, last + 1).join("");
                  if (message.length === 0) {
                    response.statusCode = 204;
                    response.end();
                  } else json(response, { ...comment, id: "draft", updated: "now", message });
                  return;
                }
                if (request.url?.endsWith("/topic")) {
                  json(response, JSON.parse(text).topic);
                  return;
                }
                if (request.url?.endsWith("/reviewers")) {
                  const body = JSON.parse(text);
                  json(response, {
                    input: body.reviewer,
                    reviewers: [{ _account_id: Number(body.reviewer) }],
                  });
                  return;
                }
                if (request.url?.endsWith("/abandon") || request.url?.endsWith("/submit")) {
                  json(response, {
                    ...(state.changes[0] as object),
                    status: request.url.endsWith("/submit") ? "MERGED" : "ABANDONED",
                  });
                  return;
                }
                json(response, { labels: { "Custom-Label": 1 } });
              });
              return;
            }
            if (state.holdSearch && request.url?.includes("/changes/?")) {
              state.holdSearch(response);
              return;
            }
            if (request.url?.endsWith("/tools/hooks/commit-msg")) {
              if (state.extras.hookRedirect) {
                response.writeHead(302, { Location: "/other" });
                response.end();
                return;
              }
              response.writeHead(200, { "Content-Type": "text/plain" });
              response.end(
                state.extras.hookOversize ? "x".repeat(65537) : "#!/bin/sh\n# server hook\n",
              );
              return;
            }
            if (request.url?.includes("/projects/") && request.url.includes("/branches/")) {
              json(response, { revision: state.extras.branchTip ?? "d".repeat(40) });
            } else if (request.url?.includes("/projects/")) {
              if (state.failProjectSearch && request.url.includes("/review/")) {
                response.statusCode = 403;
                response.end("private-project-search-error");
              } else json(response, { "Team/Shared": {}, "Other/Repo": {} });
            } else if (request.url?.includes("/content"))
              json(response, "const historical = true;\n");
            else if (request.url?.endsWith("/diff?context=ALL"))
              json(response, {
                meta_a: { name: "file" },
                meta_b: { name: "file" },
                diff_header: [],
                content: [{ a: ["before"], b: ["after"] }],
              });
            else if (request.url?.includes("/submitted_together"))
              json(response, { changes: [], non_visible_changes: state.hidden });
            else if (request.url?.endsWith("/actions"))
              json(
                response,
                state.extras.revisionActions ?? {
                  submit: { enabled: true },
                  rebase: { enabled: true },
                },
              );
            else if (request.url?.endsWith("/drafts")) json(response, state.drafts);
            else if (request.url?.endsWith("/comments"))
              json(response, state.extras.comments ?? {});
            else if (request.url?.endsWith("/ported_comments"))
              json(response, state.extras.portedComments ?? {});
            else if (request.url?.includes("accounts/self/capabilities"))
              json(response, { queryLimit: { min: 0, max: 500 } });
            else if (request.url?.includes("accounts/self"))
              json(response, { _account_id: state.account });
            else if (/\/accounts\/\d+$/.test(request.url ?? ""))
              json(
                response,
                state.extras.recipient ?? {
                  _account_id: Number(request.url?.split("/").at(-1)),
                  name: "Recipient",
                },
              );
            else if (request.url?.includes("config/server/version"))
              json(response, state.extras.version ?? "3.13.0");
            else if (request.url?.includes("/checks~checks"))
              json(response, state.extras.checks ?? []);
            else if (request.url?.includes("/related"))
              json(response, state.extras.related ?? { changes: [] });
            else if (request.url?.includes("/detail")) {
              const number = Number(/\/changes\/(\d+)\/detail/.exec(request.url)?.[1]);
              const changes = state.changes;
              const selected = changes.find(
                (change) => isNumberedChange(change) && change._number === number,
              );
              const value = Object.assign({}, selected ?? changes[0], state.extras);
              if (state.holdDetail !== null) state.holdDetail(response, value);
              else json(response, value);
            } else if (
              state.pageFailure &&
              new URL(request.url ?? "", "http://fixture.invalid").searchParams.get("S") !== "0"
            ) {
              response.statusCode = 403;
              response.end("fixture-secret-ONE");
            } else json(response, state.changes);
          });
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture address");
  const installation = yield* decodeGerritInstallationId(
    `http://127.0.0.1:${address.port}/Review/`,
  );
  const other = yield* decodeGerritInstallationId(`http://127.0.0.1:${address.port}/review/`);
  const config = yield* decodeGerritConnectionConfig({
    installation,
    authMode: "http-basic",
    bindings: [{ url: "ssh://fixture@review-alias:29418/Team/Repo", project: "Team/Repo" }],
  });
  const otherConfig = { ...config, installation: other };
  const credentials = Redacted.make({ username: "first-user", token: "fixture-secret-ONE" });
  const scope = yield* decodeGerritRepositoryScope({
    installation,
    project: "Team/Repo",
    branch: "Release/Next",
  });
  const service = yield* GerritService.GerritService;
  const fs = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig.ServerConfig;
  return {
    service,
    fs,
    serverConfig,
    installation,
    other,
    config,
    otherConfig,
    credentials,
    scope,
    state,
  };
});
const wire = (
  number: number,
  changeId: string,
  commit: string,
  parents: ReadonlyArray<string> = [],
) => ({
  project: "Team/Repo",
  branch: "Release/Next",
  change_id: changeId,
  _number: number,
  subject: `Native ${number}`,
  status: "NEW",
  owner: {},
  current_revision: commit,
  revisions: {
    [commit]: {
      _number: number + 1,
      commit: {
        parents: parents.map((commit) => ({ commit })),
        message: `Native ${number}\n\nChange-Id: ${changeId}\n`,
        author: {
          name: "Git Author",
          email: "not-account@example.invalid",
          date: "2026-10-22 00:00:00.000000000",
          tz: 0,
        },
        committer: {
          name: "Git Committer",
          email: "git@example.invalid",
          date: "2026-10-22 00:00:00.000000000",
          tz: 0,
        },
      },
    },
  },
});

it.live(
  "search does not hold the mutation lock during HTTP and later searches use new credentials",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.service.configureConnection({ config: f.config, credentials: f.credentials });
      let enter!: (response: NodeHttp.ServerResponse) => void;
      const entered = new Promise<NodeHttp.ServerResponse>((resolve) => {
        enter = resolve;
      });
      f.state.holdSearch = enter;
      const input = { installation: f.installation, status: "open" as const, limit: 1, offset: 0 };
      const search = yield* Effect.forkChild(f.service.searchChanges(input));
      const response = yield* Effect.promise(() => entered);
      const newCredentials = Redacted.make({
        username: "second-user",
        token: "fixture-secret-TWO",
      });
      yield* f.service.configureConnection({ config: f.config, credentials: newCredentials });
      f.state.holdSearch = null;
      yield* f.service.searchChanges(input);
      expect(f.state.headers).toEqual([
        `Basic ${Buffer.from("first-user:fixture-secret-ONE").toString("base64")}`,
        `Basic ${Buffer.from("second-user:fixture-secret-TWO").toString("base64")}`,
      ]);
      json(response, []);
      expect((yield* Fiber.join(search)).completeness).toBe("complete");
    }).pipe(Effect.provide(testLayer)),
);

it.live(
  "broadcasts and persists a server-owned generation for identical-config credential replacement, removal and connection deletion",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const settings = yield* ServerSettings.ServerSettingsService;
      const changes = yield* settings.subscribeChanges;
      yield* f.service.configureConnection({ config: f.config, credentials: f.credentials });
      const initial = yield* settings.getSettings;
      expect(initial.gerritCredentialGeneration).not.toBe("");
      yield* f.service.configureConnection({
        config: f.config,
        credentials: Redacted.make({ username: "other", token: "fixture-replacement" }),
      });
      const replaced = yield* settings.getSettings;
      expect(replaced.gerritConnections).toEqual(initial.gerritConnections);
      expect(replaced.gerritCredentialGeneration).not.toBe(initial.gerritCredentialGeneration);
      yield* f.service.removeCredentials(f.installation);
      const removed = yield* settings.getSettings;
      expect(removed.gerritConnections).toEqual(initial.gerritConnections);
      expect(removed.gerritCredentialGeneration).not.toBe(replaced.gerritCredentialGeneration);
      expect((yield* f.service.readConnection(f.installation))?.credentialPresent).toBe(false);
      yield* f.service.removeConnection(f.installation);
      const deleted = yield* settings.getSettings;
      expect(deleted.gerritCredentialGeneration).not.toBe(removed.gerritCredentialGeneration);
      expect(deleted.gerritConnections).toEqual({});
      const events = yield* changes.pipe(Stream.take(4), Stream.runCollect);
      expect(events.map((event) => event.gerritCredentialGeneration)).toEqual(
        [initial, replaced, removed, deleted].map((value) => value.gerritCredentialGeneration),
      );
      const persisted = JSON.parse(yield* f.fs.readFileString(f.serverConfig.settingsPath));
      expect(persisted.gerritCredentialGeneration).toBe(deleted.gerritCredentialGeneration);
      expect(JSON.stringify(events)).not.toContain("fixture-replacement");
    }).pipe(Effect.provide(testLayer)),
);

it.live("binds a verified clone without overwriting existing bindings", () =>
  Effect.gen(function* () {
    const service = yield* GerritService.GerritService;
    const installation = GerritInstallationId.make("https://review.example/");
    const config = yield* decodeGerritConnectionConfig({
      installation,
      authMode: "http-basic",
      bindings: [{ url: "https://review.example/a/CICD_Tools", project: "CICD_Tools" }],
    });
    yield* service.configureConnection({
      config,
      credentials: Redacted.make({ username: "fixture", token: "fixture" }),
    });
    const project = GerritProjectName.make("AI_Tools");
    const url = `${installation}a/AI_Tools`;
    const before = gerritRemoteConfiguration([config]);
    expect(resolveRemoteEndpoint(url, before)).toEqual({
      kind: "candidate",
      repositories: [
        { installation, project: "a/AI_Tools" },
        { installation, project },
      ],
    });
    yield* service.bindVerifiedClone({ installation, project, url });
    yield* service.bindVerifiedClone({ installation, project, url });
    const saved = (yield* service.readConnection(installation))!.config;
    expect(saved.bindings).toEqual([...config.bindings, { url, project }]);
    expect(resolveRemoteEndpoint(url, gerritRemoteConfiguration([saved]))).toEqual({
      kind: "candidate",
      repositories: [{ installation, project }],
    });
    expect(
      (yield* Effect.result(
        service.bindVerifiedClone({
          installation,
          project: GerritProjectName.make("a/AI_Tools"),
          url,
        }),
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* Effect.result(
        service.bindVerifiedClone({
          installation,
          project,
          url: "https://other.example/a/AI_Tools",
        }),
      ))._tag,
    ).toBe("Failure");
    expect((yield* service.readConnection(installation))!.config).toEqual(saved);
  }).pipe(Effect.provide(testLayer)),
);

it.live(
  "persists safe connection settings and private credentials with presence-only readback",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const saved = yield* f.service.configureConnection({
        config: f.config,
        credentials: f.credentials,
      });
      expect(saved.verification).toBe("not-tested");
      expect(saved.credentialPresent).toBe(true);
      expect(f.state.requests).toEqual([]);
      const verification = yield* f.service.testConnection(f.installation);
      expect(verification.account._account_id).toBe(42);
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      expect(settings.gerritConnections[f.installation]).toEqual(f.config);
      const client = ServerSettings.redactServerSettingsForClient(settings, {
        secretReferences: true,
      });
      const raw = yield* f.fs.readFileString(f.serverConfig.settingsPath);
      for (const output of [
        JSON.stringify(saved),
        JSON.stringify(verification),
        JSON.stringify(client),
        raw,
        JSON.stringify(yield* f.service.readConnection(f.installation)),
      ]) {
        expect(output).not.toContain("fixture-secret-ONE");
        expect(output).not.toContain("first-user");
      }
      const files = yield* f.fs
        .readDirectory(f.serverConfig.secretsDir)
        .pipe(Effect.map((files) => files.filter((file) => file.startsWith("gerrit-http-"))));
      expect(files).toHaveLength(1);
      const secretFile = `${f.serverConfig.secretsDir}/${files[0]}`;
      expect(yield* f.fs.readFileString(secretFile)).toContain("fixture-secret-ONE");
      expect((yield* f.fs.stat(secretFile)).mode & 0o777).toBe(0o600);
      expect(f.state.requests.every((p) => p.startsWith("/Review/a/"))).toBe(true);
    }).pipe(Effect.provide(testLayer)),
);

it.live("isolates two case-sensitive mounts and changes accounts without stale private reads", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.service.configureConnection({ config: f.config, credentials: f.credentials });
    yield* f.service.configureConnection({
      config: f.otherConfig,
      credentials: Redacted.make({ username: "other-user", token: "fixture-secret-TWO" }),
    });
    expect(
      yield* f.fs
        .readDirectory(f.serverConfig.secretsDir)
        .pipe(Effect.map((files) => files.filter((file) => file.startsWith("gerrit-http-")))),
    ).toHaveLength(2);
    yield* f.service.testConnection(f.installation);
    expect(f.state.headers.at(-1)).toBe(
      `Basic ${Buffer.from("first-user:fixture-secret-ONE").toString("base64")}`,
    );
    yield* f.service.testConnection(f.other);
    expect(f.state.requests.at(-1)).toBe("/review/a/accounts/self/capabilities");
    expect(f.state.headers.at(-1)).toBe(
      `Basic ${Buffer.from("other-user:fixture-secret-TWO").toString("base64")}`,
    );
    f.state.account = 99;
    yield* f.service.configureConnection({
      config: f.config,
      credentials: Redacted.make({ username: "replacement", token: "fixture-secret-NEW" }),
    });
    expect((yield* f.service.testConnection(f.installation)).account._account_id).toBe(99);
    expect(f.state.headers.at(-1)).toBe(
      `Basic ${Buffer.from("replacement:fixture-secret-NEW").toString("base64")}`,
    );
    yield* f.service.removeConnection(f.installation);
    expect(yield* f.service.readConnection(f.installation)).toBeNull();
    expect(yield* f.service.testConnection(f.installation).pipe(Effect.flip)).toMatchObject({
      reason: "not-configured",
    });
    expect(
      yield* f.fs
        .readDirectory(f.serverConfig.secretsDir)
        .pipe(Effect.map((files) => files.filter((file) => file.startsWith("gerrit-http-")))),
    ).toHaveLength(1);
    expect((yield* f.service.readConnection(f.other))?.credentialPresent).toBe(true);
    yield* f.service.removeConnection(f.installation);
    expect((yield* f.service.testConnection(f.other)).account._account_id).toBe(99);
  }).pipe(Effect.provide(testLayer)),
);

it.live("downloads only the configured server hook without credentials or redirects", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.service.configureConnection({ config: f.config, credentials: f.credentials });
    const hook = yield* f.service.downloadCloneHook(f.installation);
    expect(new TextDecoder().decode(hook)).toBe("#!/bin/sh\n# server hook\n");
    expect(f.state.requests.at(-1)).toBe(
      new URL("tools/hooks/commit-msg", f.installation).pathname,
    );
    expect(f.state.headers.at(-1)).toBe("");
    yield* f.service.removeCredentials(f.installation);
    expect((yield* f.service.readCloneConfig(f.installation))?.installation).toBe(f.installation);
    expect(new TextDecoder().decode(yield* f.service.downloadCloneHook(f.installation))).toBe(
      "#!/bin/sh\n# server hook\n",
    );
    f.state.extras.hookRedirect = true;
    expect((yield* f.service.downloadCloneHook(f.installation).pipe(Effect.flip)).reason).toBe(
      "redirect",
    );
    expect(f.state.requests.at(-1)).not.toBe("/other");
    f.state.extras.hookRedirect = false;
    f.state.extras.hookOversize = true;
    expect((yield* f.service.downloadCloneHook(f.installation).pipe(Effect.flip)).reason).toBe(
      "oversize",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.live("updates connection settings without replacing the stored credential", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.service.configureConnection({ config: f.config, credentials: f.credentials });
    const config = {
      ...f.config,
      sshHost: { host: "ssh.example.test", username: "ssh-user", port: 29418 },
    };
    const updated = yield* f.service.configureFromClient({ config });
    expect(updated.config.sshHost).toEqual(config.sshHost);
    expect(updated.credentialPresent).toBe(true);
    expect(Redacted.value((yield* f.service.resolveCloneAuth(f.installation)).credentials)).toEqual(
      Redacted.value(f.credentials),
    );
    yield* f.service.testConnection(f.installation);
    expect(f.state.headers.at(-1)).toBe(
      `Basic ${Buffer.from("first-user:fixture-secret-ONE").toString("base64")}`,
    );
    const absent = yield* f.service
      .configureFromClient({ config: f.otherConfig })
      .pipe(Effect.flip);
    expect(absent.reason).toBe("not-configured");
    yield* f.service.removeCredentials(f.installation);
    const missing = yield* f.service.configureFromClient({ config }).pipe(Effect.flip);
    expect(missing.reason).toBe("credentials-missing");
    expect((yield* f.service.readConnection(f.installation))?.config.sshHost).toEqual(
      config.sshHost,
    );
  }).pipe(Effect.provide(testLayer)),
);

it.live("refreshes cached Git credentials after connection changes", () =>
  Effect.gen(function* () {
    const auth = yield* GitHttpAuth.GitHttpAuth;
    const f = yield* fixture();
    expect(yield* auth.entries).toEqual([]);
    yield* f.service.configureConnection({ config: f.config, credentials: f.credentials });
    expect(yield* auth.entries).toContainEqual([
      `http.${f.installation}.extraHeader`,
      `Authorization: Basic ${Buffer.from("first-user:fixture-secret-ONE").toString("base64")}`,
    ]);
    yield* f.service.configureConnection({
      config: f.config,
      credentials: Redacted.make({ username: "second", token: "new-token" }),
    });
    expect(yield* auth.entries).toContainEqual([
      `http.${f.installation}.extraHeader`,
      `Authorization: Basic ${Buffer.from("second:new-token").toString("base64")}`,
    ]);
    yield* f.service.removeCredentials(f.installation);
    expect(yield* auth.entries).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.live("uses persisted settings and secret store after service reconstruction", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.service.configureConnection({ config: f.config, credentials: f.credentials });
    yield* Effect.gen(function* () {
      const service = yield* GerritService.GerritService;
      expect((yield* service.readConnection(f.installation))?.credentialPresent).toBe(true);
      expect(Redacted.value((yield* service.resolveCloneAuth(f.installation)).credentials)).toEqual(
        Redacted.value(f.credentials),
      );
      expect((yield* service.testConnection(f.installation)).account._account_id).toBe(42);
      yield* service.removeCredentials(f.installation);
      expect(yield* service.resolveCloneAuth(f.installation).pipe(Effect.flip)).toMatchObject({
        reason: "credentials-missing",
      });
    }).pipe(
      Effect.provide(
        Layer.fresh(
          GerritService.layer.pipe(
            Layer.provideMerge(ServerSettings.layer),
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(ManagedPolicy.layerTest()),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(testLayer)),
);

it.live("rejects invalid credentials and credential-bearing bindings before persistence", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(
      (yield* f.service
        .configureConnection({
          config: f.config,
          credentials: Redacted.make({ username: "bad:user", token: "fixture-secret-ONE" }),
        })
        .pipe(Effect.flip)).reason,
    ).toBe("credentials-invalid");
    const badConfig = {
      ...f.config,
      bindings: [
        {
          url: "https://user:fixture-secret-ONE@review.example/Team/Repo",
          project: f.scope.project,
        },
      ],
    };
    expect(
      (yield* f.service
        .configureConnection({ config: badConfig, credentials: f.credentials })
        .pipe(Effect.flip)).reason,
    ).toBe("invalid-input");
    expect(yield* f.service.readConnection(f.installation)).toBeNull();
    expect(
      yield* f.fs
        .readDirectory(f.serverConfig.secretsDir)
        .pipe(Effect.map((files) => files.filter((file) => file.startsWith("gerrit-http-")))),
    ).toEqual([]);
    expect(f.state.requests).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.live("fails closed on missing or corrupt stored credentials without contacting Gerrit", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.service.configureConnection({ config: f.config, credentials: f.credentials });
    const [file] = yield* f.fs
      .readDirectory(f.serverConfig.secretsDir)
      .pipe(Effect.map((files) => files.filter((file) => file.startsWith("gerrit-http-"))));
    if (file === undefined) throw new Error("Missing fixture secret");
    const path = `${f.serverConfig.secretsDir}/${file}`;
    yield* f.fs.writeFileString(path, "malformed fixture-secret-ONE");
    const invalid = yield* f.service.testConnection(f.installation).pipe(Effect.flip);
    expect(invalid.reason).toBe("credentials-invalid");
    expect(JSON.stringify(invalid)).not.toContain("fixture-secret-ONE");
    yield* f.fs.remove(path);
    expect((yield* f.service.readConnection(f.installation))?.credentialPresent).toBe(false);
    expect((yield* f.service.testConnection(f.installation).pipe(Effect.flip)).reason).toBe(
      "credentials-missing",
    );
    expect(f.state.requests).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.live("restores prior credentials when settings persistence rejects a replacement", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.service.configureConnection({ config: f.config, credentials: f.credentials });
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* Effect.gen(function* () {
      const service = yield* GerritService.GerritService;
      const result = yield* service
        .configureConnection({
          config: f.config,
          credentials: Redacted.make({ username: "replacement", token: "fixture-secret-NEW" }),
        })
        .pipe(Effect.flip);
      expect(result.reason).toBe("settings");
      expect(JSON.stringify(result)).not.toContain("fixture-secret-NEW");
    }).pipe(
      Effect.provide(Layer.fresh(GerritService.layer)),
      Effect.provideService(ServerSettings.ServerSettingsService, {
        ...settings,
        updateSettings: () =>
          Effect.fail(
            new ServerSettingsError({
              settingsPath: "fixture-secret-NEW",
              operation: "write-file",
            }),
          ),
      }),
    );
    yield* f.service.testConnection(f.installation);
    expect(f.state.headers.at(-1)).toBe(
      `Basic ${Buffer.from("first-user:fixture-secret-ONE").toString("base64")}`,
    );
  }).pipe(Effect.provide(testLayer)),
);

it.live("restores credentials when credential removal cannot publish its settings generation", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.service.configureConnection({ config: f.config, credentials: f.credentials });
    const settings = yield* ServerSettings.ServerSettingsService;
    const generation = (yield* settings.getSettings).gerritCredentialGeneration;
    yield* Effect.gen(function* () {
      const service = yield* GerritService.GerritService;
      expect((yield* service.removeCredentials(f.installation).pipe(Effect.flip)).reason).toBe(
        "settings",
      );
    }).pipe(
      Effect.provide(Layer.fresh(GerritService.layer)),
      Effect.provideService(ServerSettings.ServerSettingsService, {
        ...settings,
        updateSettings: () =>
          Effect.fail(
            new ServerSettingsError({ settingsPath: "fixture", operation: "write-file" }),
          ),
      }),
    );
    expect((yield* settings.getSettings).gerritCredentialGeneration).toBe(generation);
    expect((yield* f.service.readConnection(f.installation))?.credentialPresent).toBe(true);
    yield* f.service.testConnection(f.installation);
    expect(f.state.headers.at(-1)).toBe(
      `Basic ${Buffer.from("first-user:fixture-secret-ONE").toString("base64")}`,
    );
  }).pipe(Effect.provide(testLayer)),
);

it.live("removes a newly stored credential when settings persistence fails", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* Effect.gen(function* () {
      const service = yield* GerritService.GerritService;
      expect(
        (yield* service
          .configureConnection({ config: f.config, credentials: f.credentials })
          .pipe(Effect.flip)).reason,
      ).toBe("settings");
    }).pipe(
      Effect.provide(Layer.fresh(GerritService.layer)),
      Effect.provideService(ServerSettings.ServerSettingsService, {
        ...settings,
        updateSettings: () =>
          Effect.fail(
            new ServerSettingsError({ settingsPath: "fixture", operation: "write-file" }),
          ),
      }),
    );
    expect(
      yield* f.fs
        .readDirectory(f.serverConfig.secretsDir)
        .pipe(Effect.map((files) => files.filter((file) => file.startsWith("gerrit-http-")))),
    ).toEqual([]);
    expect(yield* f.service.readConnection(f.installation)).toBeNull();
  }).pipe(Effect.provide(testLayer)),
);

it.live("does not remove settings when secret deletion fails and allows a safe retry", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.service.configureConnection({ config: f.config, credentials: f.credentials });
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* Effect.gen(function* () {
      const service = yield* GerritService.GerritService;
      const result = yield* service.removeConnection(f.installation).pipe(Effect.flip);
      expect(result.reason).toBe("secret-store");
      expect(JSON.stringify(result)).not.toContain("fixture-secret-ONE");
    }).pipe(
      Effect.provide(Layer.fresh(GerritService.layer)),
      Effect.provideService(ServerSecretStore.ServerSecretStore, {
        ...secrets,
        remove: () =>
          Effect.fail(
            new ServerSecretStore.SecretStoreRemoveError({
              resource: "fixture-secret-ONE",
              cause: "private",
            }),
          ),
      }),
    );
    expect((yield* f.service.readConnection(f.installation))?.credentialPresent).toBe(true);
    yield* f.service.removeConnection(f.installation);
    yield* f.service.removeConnection(f.installation);
    expect(yield* f.service.readConnection(f.installation)).toBeNull();
  }).pipe(Effect.provide(testLayer)),
);

it.live("normalizes secret-write failure and never persists a partial connection", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* Effect.gen(function* () {
      const service = yield* GerritService.GerritService;
      const result = yield* service
        .configureConnection({ config: f.config, credentials: f.credentials })
        .pipe(Effect.flip);
      expect(result.reason).toBe("secret-store");
      expect(JSON.stringify(result)).not.toContain("fixture-secret-ONE");
    }).pipe(
      Effect.provide(Layer.fresh(GerritService.layer)),
      Effect.provideService(ServerSecretStore.ServerSecretStore, {
        ...secrets,
        set: (name, bytes) =>
          secrets.set(name, bytes).pipe(
            Effect.andThen(
              Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: "fixture-secret-ONE",
                  cause: "private",
                }),
              ),
            ),
          ),
      }),
    );
    expect(
      yield* f.fs
        .readDirectory(f.serverConfig.secretsDir)
        .pipe(Effect.map((files) => files.filter((file) => file.startsWith("gerrit-http-")))),
    ).toEqual([]);
    expect(yield* f.service.readConnection(f.installation)).toBeNull();
  }).pipe(Effect.provide(testLayer)),
);

it.live("keeps credentials isolated between installations on different ports", () =>
  Effect.gen(function* () {
    const first = yield* fixture();
    const second = yield* fixture();
    expect(first.installation).not.toBe(second.installation);
    yield* first.service.configureConnection({
      config: first.config,
      credentials: first.credentials,
    });
    yield* second.service.configureConnection({
      config: second.config,
      credentials: Redacted.make({ username: "second-port", token: "fixture-secret-TWO" }),
    });
    expect(
      yield* first.fs
        .readDirectory(first.serverConfig.secretsDir)
        .pipe(Effect.map((files) => files.filter((file) => file.startsWith("gerrit-http-")))),
    ).toHaveLength(2);
    yield* first.service.testConnection(first.installation);
    yield* second.service.testConnection(second.installation);
    expect(first.state.headers.at(-1)).toBe(
      `Basic ${Buffer.from("first-user:fixture-secret-ONE").toString("base64")}`,
    );
    expect(second.state.headers.at(-1)).toBe(
      `Basic ${Buffer.from("second-port:fixture-secret-TWO").toString("base64")}`,
    );
  }).pipe(Effect.provide(testLayer)),
);

it.live(
  "restores credentials when connection deletion cannot publish its settings generation and converges on retry",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.service.configureConnection({ config: f.config, credentials: f.credentials });
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* Effect.gen(function* () {
        const service = yield* GerritService.GerritService;
        expect((yield* service.removeConnection(f.installation).pipe(Effect.flip)).reason).toBe(
          "settings",
        );
      }).pipe(
        Effect.provide(Layer.fresh(GerritService.layer)),
        Effect.provideService(ServerSettings.ServerSettingsService, {
          ...settings,
          updateSettings: () =>
            Effect.fail(
              new ServerSettingsError({ settingsPath: "fixture", operation: "write-file" }),
            ),
        }),
      );
      expect((yield* f.service.readConnection(f.installation))?.credentialPresent).toBe(true);
      yield* f.service.testConnection(f.installation);
      expect(f.state.headers.at(-1)).toBe(
        `Basic ${Buffer.from("first-user:fixture-secret-ONE").toString("base64")}`,
      );
      yield* f.service.removeConnection(f.installation);
      expect(yield* f.service.readConnection(f.installation)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
);

it.live("sanitizes a secret-store read error before it leaves the service", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.service.configureConnection({ config: f.config, credentials: f.credentials });
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* Effect.gen(function* () {
      const service = yield* GerritService.GerritService;
      const error = yield* service.testConnection(f.installation).pipe(Effect.flip);
      expect(error.reason).toBe("secret-store");
      expect(JSON.stringify(error)).not.toContain("fixture-secret-ONE");
      expect(error).not.toHaveProperty("cause");
    }).pipe(
      Effect.provide(Layer.fresh(GerritService.layer)),
      Effect.provideService(ServerSecretStore.ServerSecretStore, {
        ...secrets,
        get: () =>
          Effect.fail(
            new ServerSecretStore.SecretStoreReadError({
              resource: "fixture-secret-ONE",
              cause: "private",
            }),
          ),
      }),
    );
    expect(f.state.requests).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.live(
  "searches each configured Gerrit installation and keeps duplicate projects selectable",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const firstConfig = {
        ...f.config,
        sshHost: { host: "ssh-first.example.test", port: 29418, username: "ssh-first" },
      };
      const secondConfig = {
        ...f.otherConfig,
        sshHost: { host: "ssh-second.example.test", port: 29418, username: "ssh-second" },
      };
      yield* f.service.configureFromClient({
        config: firstConfig,
        credentials: { username: "first-user", token: "token-one" },
      });
      yield* f.service.configureFromClient({
        config: secondConfig,
        credentials: { username: "second-user", token: "token-two" },
      });
      const complete = yield* f.service.searchProjects({ query: "Shared" });
      expect(complete.configuredInstallations).toBe(2);
      expect(complete.results.filter((project) => project.project === "Team/Shared")).toHaveLength(
        2,
      );
      expect(complete.results.map((project) => project.installation).sort()).toEqual(
        [f.installation, f.other].sort(),
      );
      expect(complete.results.map((project) => project.sshUrl)).toContain(
        "ssh://ssh-first@ssh-first.example.test:29418/Team/Shared",
      );
      expect(complete.results.map((project) => project.sshUrl)).toContain(
        "ssh://ssh-second@ssh-second.example.test:29418/Team/Shared",
      );
      expect(complete.results.map((project) => project.httpUrl)).toContain(
        `${f.installation}a/Team/Shared`,
      );
      expect(complete.results.map((project) => project.httpUrl)).toContain(
        `${f.other}a/Team/Shared`,
      );
      expect(complete.results.map((project) => project.projectUrl)).toContain(
        `${f.installation}q/project:Team/Shared`,
      );
      expect(complete.results.map((project) => project.projectUrl)).toContain(
        `${f.other}q/project:Team/Shared`,
      );
      yield* f.service.configureFromClient({
        config: { ...secondConfig, sshHost: { host: "ssh-second.example.test", port: 29418 } },
        credentials: { username: "second-user", token: "token-two" },
      });
      const withoutSshUser = yield* f.service.searchProjects({ query: "Shared" });
      expect(
        withoutSshUser.results.find((result) => result.installation === f.other)
          ?.preferredTransport,
      ).toBeUndefined();
      f.state.failProjectSearch = true;
      const partial = yield* f.service.searchProjects({ query: "Shared" });
      expect(partial.results.filter((project) => project.project === "Team/Shared")).toHaveLength(
        1,
      );
      expect(partial.failures).toEqual([
        { installation: f.other, detail: "Could not search this installation." },
      ]);
      expect(JSON.stringify(partial)).not.toContain("token-one");
      expect(JSON.stringify(partial)).not.toContain("token-two");
    }).pipe(Effect.provide(testLayer)),
);

const writeFixture = Effect.fn("GerritService.test.writeFixture")(function* () {
  const f = yield* fixture();
  const revision = "a".repeat(40);
  const changeId = `I${"c".repeat(40)}`;
  f.state.changes = [wire(1, changeId, revision, ["d".repeat(40)])];
  f.state.extras = {
    permitted_labels: { "Custom-Label": ["-1", " 0", "+1"] },
    updated: "before",
    actions: {
      topic: { enabled: true },
      abandon: { enabled: true },
      "rebase:chain": { enabled: true },
    },
  };
  yield* f.service.configureConnection({ config: f.config, credentials: f.credentials });
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const issued = yield* auth.issueSession({
    scopes: ["source-control:write", "orchestration:read"],
  });
  const session = yield* auth.authenticateHttpRequest(
    HttpServerRequest.fromWeb(
      new Request("http://localhost/", { headers: { Authorization: `Bearer ${issued.token}` } }),
    ),
  );
  const input = { key: { ...f.scope, changeId }, number: 1, revision };
  return { ...f, auth, session, input, token: issued.token };
});

it.live(
  "resolves the delivery change from the checkout and the HEAD Change-Id, not the local branch",
  () =>
    Effect.gen(function* () {
      const f = yield* writeFixture();
      const cwd = yield* f.fs.makeTempDirectoryScoped({ prefix: "g3-delivery-" });
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const git = Effect.fn("GerritService.test.deliveryGit")((args: ReadonlyArray<string>) =>
        driver.execute({ cwd, operation: "GerritService.test.delivery", args }),
      );
      yield* git(["init", "--initial-branch=feature-local"]);
      yield* git(["config", "user.name", "Fixture Deliverer"]);
      yield* git(["config", "user.email", "deliverer@example.invalid"]);
      yield* git(["commit", "--allow-empty", "-m", "Base"]);
      const parent = GitCommitOid.make((yield* git(["rev-parse", "HEAD"])).stdout.trim());
      yield* git([
        "commit",
        "--allow-empty",
        "-m",
        `Delivery\n\nChange-Id: ${f.input.key.changeId}\n`,
      ]);
      const remoteRevision = GitCommitOid.make((yield* git(["rev-parse", "HEAD"])).stdout.trim());
      yield* git([
        "commit",
        "--amend",
        "--allow-empty",
        "-m",
        `Amended\n\nChange-Id: ${f.input.key.changeId}\n`,
      ]);
      const head = GitCommitOid.make((yield* git(["rev-parse", "HEAD"])).stdout.trim());
      expect(head).not.toBe(remoteRevision);
      const destination = "ssh://fixture@review-alias:29418/Team/Repo";
      yield* git(["remote", "add", "origin", destination]);
      f.state.changes = [wire(1, f.input.key.changeId, remoteRevision, [parent])];
      yield* f.service.configureConnection({
        config: {
          ...f.config,
          sshHost: { host: "review-alias", port: 29418 },
          bindings: [],
        },
        credentials: f.credentials,
      });
      const checkout = yield* f.service.deliveryCheckout({ cwd });
      expect(checkout).toMatchObject({
        kind: "ready",
        localBranch: "feature-local",
        head,
        change: {
          key: { branch: "Release/Next", changeId: f.input.key.changeId },
          number: 1,
          revision: { commit: remoteRevision, patchSet: 2 },
        },
        files: [],
      });
      f.state.changes = [];
      expect(yield* f.service.deliveryCheckout({ cwd })).toMatchObject({
        kind: "blocked",
        detail: expect.stringContaining("destination branch"),
      });
      expect(
        yield* f.service.deliveryCheckout({
          cwd,
          targetBranch: GerritRemoteTargetBranch.make("main"),
        }),
      ).toMatchObject({
        kind: "new-change",
        key: { ...f.scope, branch: "main", changeId: f.input.key.changeId },
        head,
        files: [],
      });
      f.state.changes = [
        wire(1, f.input.key.changeId, remoteRevision, [parent]),
        wire(2, f.input.key.changeId, remoteRevision, [parent]),
      ];
      expect(yield* f.service.deliveryCheckout({ cwd })).toMatchObject({
        kind: "blocked",
        detail: expect.stringContaining("ambiguous"),
      });
      f.state.changes = [
        { ...wire(1, f.input.key.changeId, remoteRevision, [parent]), status: "MERGED" },
      ];
      expect(yield* f.service.deliveryCheckout({ cwd })).toMatchObject({
        kind: "blocked",
        detail: expect.stringContaining("MERGED"),
      });
    }).pipe(Effect.provide(testLayer)),
);

const hookFixture = Effect.fn("GerritService.test.hookFixture")(function* () {
  const f = yield* writeFixture();
  const cwd = yield* f.fs.makeTempDirectoryScoped({ prefix: "gerrit-hook-" });
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const git = Effect.fn("GerritService.test.hookGit")((args: ReadonlyArray<string>) =>
    driver.execute({
      cwd,
      operation: "GerritService.test.hook",
      args,
      env: { GIT_CONFIG_COUNT: "0" },
    }),
  );
  yield* git(["init", "--initial-branch=stack"]);
  yield* git(["config", "user.name", "Fixture"]);
  yield* git(["config", "user.email", "fixture@example.invalid"]);
  const host = yield* SourceControlHost.SourceControlHost;
  const service = yield* GerritService.GerritService.pipe(
    Effect.provide(Layer.fresh(GerritService.layer)),
    Effect.provideService(SourceControlHost.SourceControlHost, {
      ...host,
      process: {
        run: (input) =>
          host.process.run({ ...input, env: { ...input.env, GIT_CONFIG_COUNT: "0" } }),
      },
    }),
  );
  return { ...f, service, cwd, git };
});

it.live("installs the exact pinned official hook and generates and preserves Change-Ids", () =>
  Effect.gen(function* () {
    const f = yield* hookFixture();
    const before = yield* f.service.readHook({ cwd: f.cwd });
    expect(before.state).toBe("missing");
    expect(yield* f.fs.exists(before.destination)).toBe(false);
    const installed = yield* f.service.installHook(f.session, { cwd: f.cwd });
    expect(installed.state).toBe("official");
    expect(installed.source).toMatchObject({
      version: "3.10.2",
      license: "Apache-2.0",
      sha256: before.source.sha256,
    });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const trace = `${f.cwd}/.git/hook-trace.jsonl`;
    const commitDriver = yield* GitVcsDriver.GitVcsDriver.pipe(
      Effect.provide(Layer.fresh(GitVcsDriver.layer)),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          spawner.spawn(
            command._tag === "StandardCommand" && command.options.cwd === f.cwd
              ? ChildProcess.setEnv(command, { GIT_CONFIG_COUNT: "0", GIT_TRACE2_EVENT: trace })
              : command,
          ),
        ),
      ),
    );
    yield* f.fs.writeFileString(`${f.cwd}/new-file`, "first change\n");
    const created = yield* commitDriver.commit(f.cwd, "New change", "", { stage: {} });
    expect((yield* f.git(["rev-parse", "HEAD"])).stdout.trim()).toBe(created.commitSha);
    const message = (yield* f.git(["show", "-s", "--format=%B", created.commitSha])).stdout;
    const identity = commitIdentity(message);
    expect(identity.kind).toBe("valid");
    if (identity.kind !== "valid") throw new Error("Hook did not generate a valid Change-Id");
    expect(yield* f.fs.readFileString(trace)).toMatch(/"hook_name":"commit-msg"/);
    const original = { oid: yield* decodeGitCommitOid(created.commitSha), parents: [], message };
    const visible = {
      changes: [],
      observedAt: "2026-10-25T00:00:00.000Z",
      completeness: "complete-visible" as const,
    };
    expect(mapLocalCommits({ commits: [original], scope: f.scope, visible })[0]?.mapping).toEqual({
      kind: "new-candidate",
      key: { ...f.scope, changeId: identity.changeId },
    });
    yield* f.fs.writeFileString(`${f.cwd}/new-file`, "second change\n");
    const second = yield* commitDriver.commit(f.cwd, "Another change", "", { stage: {} });
    const secondMessage = (yield* f.git(["show", "-s", "--format=%B", second.commitSha])).stdout;
    const secondIdentity = commitIdentity(secondMessage);
    expect(secondIdentity.kind).toBe("valid");
    if (secondIdentity.kind !== "valid") throw new Error("Hook did not generate second Change-Id");
    expect(secondIdentity.changeId).not.toBe(identity.changeId);
    const commits = [
      original,
      {
        oid: yield* decodeGitCommitOid(second.commitSha),
        parents: [original.oid],
        message: secondMessage,
      },
    ];
    expect(
      mapLocalCommits({ commits, scope: f.scope, visible }).map((commit) => commit.mapping.kind),
    ).toEqual(["new-candidate", "new-candidate"]);
    expect(
      mapLocalCommits({
        commits: [original, { ...commits[1], oid: original.oid, parents: [], message }],
        scope: f.scope,
        visible,
      }).map((commit) => commit.mapping),
    ).toEqual([
      { kind: "invalid", problems: ["duplicate-local-change-id"] },
      { kind: "invalid", problems: ["duplicate-local-change-id"] },
    ]);
    yield* f.git(["reset", "--hard", created.commitSha]);
    yield* f.git(["commit", "--amend", "--allow-empty", "--no-edit"]);
    expect((yield* f.git(["show", "-s", "--format=%B", "HEAD"])).stdout).toBe(message);
    yield* f.git(["commit", "--allow-empty", "-m", "fixup! Suppressed"]);
    expect((yield* f.git(["show", "-s", "--format=%B", "HEAD"])).stdout).not.toContain(
      "Change-Id:",
    );
    yield* f.git(["config", "gerrit.createChangeId", "always"]);
    yield* f.git(["commit", "--allow-empty", "-m", "fixup! Explicit generation"]);
    expect((yield* f.git(["show", "-s", "--format=%B", "HEAD"])).stdout).toMatch(
      /Change-Id: I[0-9a-f]{40}/,
    );
    expect(yield* f.service.installHook(f.session, { cwd: f.cwd }).pipe(Effect.flip)).toMatchObject(
      {
        reason: "conflict",
      },
    );
    expect(f.state.writes).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.live(
  "does not replace custom or inactive hooks and diagnoses hooksPath, Link trailers and disabled generation",
  () =>
    Effect.gen(function* () {
      const f = yield* hookFixture();
      const before = yield* f.service.readHook({ cwd: f.cwd });
      yield* f.fs.writeFileString(before.destination, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect((yield* f.service.readHook({ cwd: f.cwd })).state).toBe("custom");
      expect(
        yield* f.service.installHook(f.session, { cwd: f.cwd }).pipe(Effect.flip),
      ).toMatchObject({ reason: "conflict" });
      expect(yield* f.fs.readFileString(before.destination)).toBe("#!/bin/sh\nexit 0\n");
      yield* f.git(["config", "core.hooksPath", "custom-hooks"]);
      const custom = yield* f.service.readHook({ cwd: f.cwd });
      expect(custom.state).toBe("unsafe");
      expect(custom.issues).toContain("custom-hooks-path-installation-unsupported");
      yield* f.git(["config", "--unset", "core.hooksPath"]);
      yield* f.fs.remove(before.destination);
      yield* f.git(["config", "gerrit.reviewUrl", "https://review.example/Review"]);
      expect((yield* f.service.readHook({ cwd: f.cwd })).issues).toContain(
        "link-trailer-generation-unsupported",
      );
      expect(
        yield* f.service.installHook(f.session, { cwd: f.cwd }).pipe(Effect.flip),
      ).toMatchObject({ reason: "unsafe" });
      yield* f.git(["config", "--unset", "gerrit.reviewUrl"]);
      yield* f.git(["config", "gerrit.createChangeId", "false"]);
      expect((yield* f.service.readHook({ cwd: f.cwd })).issues).toContain(
        "change-id-generation-disabled",
      );
      expect(
        yield* f.service.installHook(f.session, { cwd: f.cwd }).pipe(Effect.flip),
      ).toMatchObject({ reason: "unsafe" });
    }).pipe(Effect.provide(testLayer)),
);

it.live("rejects destination conflicts, forged sessions, MCP and revoked app sessions", () =>
  Effect.gen(function* () {
    const f = yield* hookFixture();
    expect(
      yield* f.service.installHook({ ...f.session }, { cwd: f.cwd }).pipe(Effect.flip),
    ).toMatchObject({ reason: "authority" });
    expect(
      yield* f.service
        .installHook({ ...f.session, subject: "mcp-client" }, { cwd: f.cwd })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "authority" });
    const diagnosis = yield* f.service.readHook({ cwd: f.cwd });
    yield* f.fs.writeFileString(diagnosis.destination, "custom");
    expect(yield* f.service.installHook(f.session, { cwd: f.cwd }).pipe(Effect.flip)).toMatchObject(
      {
        reason: "conflict",
      },
    );
    expect(yield* f.fs.readFileString(diagnosis.destination)).toBe("custom");
    yield* f.fs.remove(diagnosis.destination);
    yield* (yield* SessionStore.SessionStore).revoke(f.session.sessionId);
    expect(yield* f.service.installHook(f.session, { cwd: f.cwd }).pipe(Effect.flip)).toMatchObject(
      {
        reason: "authority",
      },
    );
    expect(yield* f.fs.exists(diagnosis.destination)).toBe(false);
  }).pipe(Effect.provide(testLayer)),
);

it.live("uses the common hook for linked worktrees and rejects hook symlinks", () =>
  Effect.gen(function* () {
    const f = yield* hookFixture();
    yield* f.git(["commit", "--allow-empty", "-m", "Boundary"]);
    const linked = `${f.cwd}/linked`;
    yield* f.git(["worktree", "add", "--detach", linked]);
    const diagnosis = yield* f.service.readHook({ cwd: linked });
    expect(diagnosis.destination).toBe(`${f.cwd}/.git/hooks/commit-msg`);
    yield* f.fs.rename(`${f.cwd}/.git/hooks`, `${f.cwd}/.git/previous-hooks`);
    yield* f.fs.makeDirectory(`${f.cwd}/.git/hooks`);
    const target = `${f.cwd}/custom-hook`;
    yield* f.fs.writeFileString(target, "custom");
    yield* f.fs.symlink(target, diagnosis.destination);
    expect((yield* f.service.readHook({ cwd: linked })).state).toBe("unsafe");
    expect(
      yield* f.service.installHook(f.session, { cwd: linked }).pipe(Effect.flip),
    ).toMatchObject({ reason: "conflict" });
    expect(yield* f.fs.readFileString(target)).toBe("custom");
    yield* f.fs.remove(diagnosis.destination);
    expect((yield* f.service.installHook(f.session, { cwd: linked })).state).toBe("official");
    expect((yield* f.service.readHook({ cwd: f.cwd })).state).toBe("official");
  }).pipe(Effect.provide(testLayer)),
);

it.live.each(["revoked", "generation", "environment"] as const)(
  "rejects %s authority at the last real hook inspection without a destination",
  (variant) =>
    Effect.gen(function* () {
      const f = yield* hookFixture();
      const host = yield* SourceControlHost.SourceControlHost;
      const settings = yield* ServerSettings.ServerSettingsService;
      const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
      const originalEnvironment = yield* identity.getEnvironmentId;
      let environmentId = originalEnvironment;
      const reached = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let armed = false;
      let rechecks = 0;
      yield* Effect.gen(function* () {
        const service = yield* GerritService.GerritService;
        const diagnosis = yield* service.readHook({ cwd: f.cwd });
        armed = true;
        const install = yield* service
          .installHook(f.session, { cwd: f.cwd })
          .pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(reached);
        if (variant === "revoked")
          yield* (yield* SessionStore.SessionStore).revoke(f.session.sessionId);
        if (variant === "generation") yield* settings.updateSettings({ gerritConnections: {} });
        if (variant === "environment")
          environmentId = EnvironmentId.make("changed-hook-environment");
        yield* Deferred.succeed(resume, undefined);
        const result = yield* Fiber.join(install);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            reason: variant === "revoked" ? "authority" : "stale",
          });
        expect(yield* f.fs.exists(diagnosis.destination)).toBe(false);
        expect(
          (yield* f.fs.readDirectory(`${f.cwd}/.git/hooks`)).filter((name) =>
            name.startsWith(".t3-commit-msg-"),
          ),
        ).toEqual([]);
        environmentId = originalEnvironment;
        expect(f.state.writes).toEqual([]);
      }).pipe(
        Effect.provide(Layer.fresh(GerritService.layer)),
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.sync(() => environmentId),
        }),
        Effect.provideService(SourceControlHost.SourceControlHost, {
          ...host,
          process: {
            run: (input) =>
              Effect.gen(function* () {
                const result = yield* host.process.run({
                  ...input,
                  env: { ...input.env, GIT_CONFIG_COUNT: "0" },
                });
                if (armed && input.args.at(-1) === "gerrit.reviewUrl" && ++rechecks === 2) {
                  yield* Deferred.succeed(reached, undefined);
                  yield* Deferred.await(resume);
                }
                return result;
              }),
          },
        }),
        Effect.provide(TestClock.layer()),
      );
    }).pipe(Effect.provide(testLayer)),
);
