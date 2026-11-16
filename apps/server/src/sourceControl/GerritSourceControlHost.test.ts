import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as GerritLocalCommits from "@t3tools/source-control-gerrit/server/GerritLocalCommits";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GerritRemotes from "@t3tools/source-control-gerrit/server/GerritRemotes";
import {
  GerritRemoteConfiguration,
  GerritRemoteRepository,
  GerritRemoteTargetBranch,
} from "@t3tools/source-control-gerrit/server/remoteBinding";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { GerritRepositoryScope, GerritVisibleChanges, GitCommitOid } from "@t3tools/contracts";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";

const decodeOid = Schema.decodeEffect(GitCommitOid);
const decodeConfiguration = Schema.decodeSync(GerritRemoteConfiguration);
const decodeRepository = Schema.decodeSync(GerritRemoteRepository);
const isConfiguration = Schema.is(GerritRemoteConfiguration);

const hostLayer = ServerSourceControlHost.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-gerrit-host-config-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(NodeCrypto.layer),
);
const testLayer = Layer.merge(GerritLocalCommits.layer, GerritRemotes.layer).pipe(
  Layer.provideMerge(hostLayer),
);
const configuration = decodeConfiguration({
  confirmedInstallations: ["https://review.example:8443/Review/"],
  exactBindings: [],
});
const target = Schema.decodeSync(GerritRemoteTargetBranch)("Release/Next");
const repository = decodeRepository({
  installation: "https://review.example:8443/Review/",
  project: "Team/Repo",
});
const literalRepository = decodeRepository({ ...repository, project: "a/Team/Repo" });
const scope = Schema.decodeSync(GerritRepositoryScope)({
  installation: "https://review.example:8443/Review/",
  project: "Team/Repo",
  branch: "Release/Next",
});
const visible = Schema.decodeSync(GerritVisibleChanges)({
  changes: [],
  completeness: "complete-visible",
  observedAt: "2026-10-22T00:00:00.000Z",
});

const fixture = Effect.fn("GerritSourceControlHost.test.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const cwd = yield* fs.makeTempDirectoryScoped({
    prefix: "t3-gerrit-host-",
  });
  const git = Effect.fn("GerritSourceControlHost.test.git")(function* (
    args: ReadonlyArray<string>,
  ) {
    return yield* driver.execute({ operation: "GerritSourceControlHost.test", cwd, args });
  });
  yield* git(["init", "--initial-branch=LocalStack"]);
  yield* git(["config", "core.hooksPath", path.join(cwd, "disabled-hooks")]);
  yield* git(["config", "commit.gpgSign", "false"]);
  yield* git(["config", "user.name", "Fixture"]);
  yield* git(["config", "user.email", "fixture@example.invalid"]);
  const commit = Effect.fn("GerritSourceControlHost.test.commit")(function* (message: string) {
    yield* fs.writeFileString(path.join(cwd, "message"), message);
    yield* git(["commit", "--quiet", "--allow-empty", "--cleanup=verbatim", "-F", "message"]);
    return yield* decodeOid((yield* git(["rev-parse", "HEAD"])).stdout.trim());
  });
  const base = yield* commit("Base");
  return { cwd, fs, path, git, commit, base };
});

it.live("reads real configured and effective remotes through the production host", () =>
  Effect.gen(function* () {
    const repo = yield* fixture();
    const host = yield* SourceControlHost.SourceControlHost;
    yield* repo.git(["remote", "add", "origin", "https://github.com/example/repo.git"]);
    yield* repo.git(["remote", "add", "review", "review:Team/Repo"]);
    yield* repo.git(["config", "url.https://review.example:8443/Review/.insteadOf", "review:"]);
    const configured = yield* host.git.execute({
      cwd: repo.cwd,
      operation: "GerritSourceControlHost.test.read",
      args: [
        "--no-lazy-fetch",
        "--no-replace-objects",
        "--no-optional-locks",
        "config",
        "--null",
        "--list",
      ],
      maxOutputBytes: 1024 * 1024,
      appendTruncationMarker: false,
    });
    expect(configured.stdout).toContain("remote.review.url\nreview:Team/Repo\0");
    const effective = yield* host.git.execute({
      cwd: repo.cwd,
      operation: "GerritSourceControlHost.test.read",
      args: [
        "--no-lazy-fetch",
        "--no-replace-objects",
        "--no-optional-locks",
        "remote",
        "get-url",
        "--all",
        "review",
      ],
      maxOutputBytes: 1024 * 1024,
      appendTruncationMarker: false,
    });
    expect(effective.stdout).toBe("https://review.example:8443/Review/Team/Repo\n");
  }).pipe(Effect.provide(testLayer)),
);

it.live("maps the ordinary accepted A-B-C range with the production host", () =>
  Effect.gen(function* () {
    const repo = yield* fixture();
    const reader = yield* GerritLocalCommits.GerritLocalCommits;
    const commits = yield* Effect.forEach(["a", "b", "c"], (hex) =>
      repo.commit(`${hex}\n\nChange-Id: I${hex.repeat(40)}`),
    );
    const tip = yield* decodeOid((yield* repo.git(["rev-parse", "HEAD"])).stdout.trim());
    const result = yield* reader.discover({ cwd: repo.cwd, base: repo.base, tip, scope, visible });
    expect(result.commits.map((commit) => commit.oid)).toEqual(commits);
    expect(result.commits.map((commit) => commit.parents)).toEqual([
      [repo.base],
      [commits[0]],
      [commits[1]],
    ]);
    expect(result.commits.map((commit) => commit.mapping.kind)).toEqual([
      "new-candidate",
      "new-candidate",
      "new-candidate",
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.live("fails closed on an actual oversized commit through the production output collector", () =>
  Effect.gen(function* () {
    const repo = yield* fixture();
    const reader = yield* GerritLocalCommits.GerritLocalCommits;
    const tip = yield* repo.commit(
      `${"x".repeat(1024 * 1024 + 1)}\n\nChange-Id: I${"a".repeat(40)}`,
    );
    const result = yield* Effect.result(
      reader.discover({ cwd: repo.cwd, base: repo.base, tip, scope, visible }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure._tag).toBe("GitCommandError");
    if (result.failure._tag !== "GitCommandError") return;
    expect(result.failure.outputLength).toBeGreaterThan(1024 * 1024);
    expect(result.failure.detail).toBe("Git output exceeded 1048576 bytes and was truncated.");
  }).pipe(Effect.provide(testLayer)),
);

it.live(
  "binds a separate Gerrit remote without choosing GitHub origin and preserves dirty repository state",
  () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const service = yield* GerritRemotes.GerritRemotes;
      yield* repo.git(["remote", "add", "origin", "https://github.com/example/repo.git"]);
      yield* repo.git(["remote", "add", "review", "https://review.example:8443/Review/Team/Repo"]);
      yield* repo.git(["config", "branch.LocalStack.remote", "origin"]);
      yield* repo.git(["config", "branch.LocalStack.merge", "refs/heads/GitHubMain"]);
      yield* repo.fs.writeFileString(repo.path.join(repo.cwd, "tracked"), "base");
      yield* repo.git(["add", "tracked"]);
      yield* repo.git(["commit", "--quiet", "-m", "Track fixture file"]);
      yield* repo.fs.writeFileString(repo.path.join(repo.cwd, "tracked"), "staged");
      yield* repo.git(["add", "tracked"]);
      yield* repo.fs.writeFileString(repo.path.join(repo.cwd, "tracked"), "dirty");
      yield* repo.fs.writeFileString(repo.path.join(repo.cwd, "untracked"), "keep");
      yield* repo.fs.makeDirectory(repo.path.join(repo.cwd, ".ssh"));
      yield* repo.fs.writeFileString(
        repo.path.join(repo.cwd, ".ssh/config"),
        "Host fixture-alias\n HostName never-contact.invalid\n",
      );
      const configBefore = yield* repo.fs.readFileString(repo.path.join(repo.cwd, ".git/config"));
      const indexBefore = yield* repo.fs.readFile(repo.path.join(repo.cwd, ".git/index"));
      const refsBefore = (yield* repo.git(["show-ref"])).stdout;
      const statusBefore = (yield* repo.git(["--no-optional-locks", "status", "--porcelain=v1"]))
        .stdout;
      const result = yield* service.discover({ cwd: repo.cwd, configuration, target });
      expect(result.binding).toEqual({ kind: "bound", scope });
      expect(result.remotes.map((remote) => remote.name)).toEqual(["origin", "review"]);
      expect(result.upstream).toEqual({
        kind: "branch",
        localBranch: "LocalStack",
        remoteNames: ["origin"],
        mergeBranches: ["GitHubMain"],
      });
      expect((yield* service.discover({ cwd: repo.cwd, configuration })).binding).toEqual({
        kind: "target-required",
        repository,
      });
      expect(yield* repo.fs.readFileString(repo.path.join(repo.cwd, ".git/config"))).toBe(
        configBefore,
      );
      expect(yield* repo.fs.readFile(repo.path.join(repo.cwd, ".git/index"))).toEqual(indexBefore);
      expect((yield* repo.git(["show-ref"])).stdout).toBe(refsBefore);
      expect((yield* repo.git(["--no-optional-locks", "status", "--porcelain=v1"])).stdout).toBe(
        statusBefore,
      );
      expect(yield* repo.fs.readFileString(repo.path.join(repo.cwd, "tracked"))).toBe("dirty");
      expect(yield* repo.fs.readFileString(repo.path.join(repo.cwd, "untracked"))).toBe("keep");
      expect(yield* repo.fs.readFileString(repo.path.join(repo.cwd, ".ssh/config"))).toBe(
        "Host fixture-alias\n HostName never-contact.invalid\n",
      );
    }).pipe(Effect.provide(testLayer)),
);

it.live(
  "keeps multiple configured and effective fetch/push destinations and Git rewrites distinct",
  () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const service = yield* GerritRemotes.GerritRemotes;
      yield* repo.git(["remote", "add", "review", "review:Team/Repo"]);
      yield* repo.git(["config", "--add", "remote.review.url", "review:Single"]);
      yield* repo.git(["config", "url.https://review.example:8443/Review/.insteadOf", "review:"]);
      yield* repo.git(["config", "url.ssh://git@fixture-alias:29418/.pushInsteadOf", "review:"]);
      const rewritten = yield* service.discover({ cwd: repo.cwd, configuration, target });
      expect(rewritten.remotes[0]?.configured.fetch).toEqual([
        { kind: "unknown", transport: "ssh" },
        { kind: "unknown", transport: "ssh" },
      ]);
      expect(rewritten.remotes[0]?.configured.push).toEqual([]);
      expect(rewritten.remotes[0]?.effective.fetch).toEqual([
        { kind: "candidate", repositories: [repository] },
        { kind: "candidate", repositories: [{ ...repository, project: "Single" }] },
      ]);
      expect(rewritten.remotes[0]?.effective.push).toEqual([
        { kind: "unknown", transport: "ssh" },
        { kind: "unknown", transport: "ssh" },
      ]);
      expect(rewritten.binding.kind).toBe("ambiguous");
      yield* repo.git(["config", "--add", "remote.review.pushurl", "review:PushOne"]);
      yield* repo.git(["config", "--add", "remote.review.pushurl", "review:PushTwo"]);
      const explicit = yield* service.discover({
        cwd: repo.cwd,
        configuration,
        repository,
        target,
      });
      expect(explicit.remotes[0]?.configured.push).toHaveLength(2);
      expect(explicit.remotes[0]?.effective.push).toEqual([
        { kind: "candidate", repositories: [{ ...repository, project: "PushOne" }] },
        { kind: "candidate", repositories: [{ ...repository, project: "PushTwo" }] },
      ]);
      expect(explicit.binding).toEqual({ kind: "bound", scope });
    }).pipe(Effect.provide(testLayer)),
);

it.live("requires exact SSH alias binding and leaves two plausible review scopes ambiguous", () =>
  Effect.gen(function* () {
    const repo = yield* fixture();
    const service = yield* GerritRemotes.GerritRemotes;
    const url = "git@fixture-alias:Team/Repo";
    yield* repo.git(["remote", "add", "gerrit", url]);
    expect((yield* service.discover({ cwd: repo.cwd, configuration, target })).binding.kind).toBe(
      "not-bound",
    );
    const boundConfiguration = decodeConfiguration({
      ...configuration,
      exactBindings: [{ url, repository }],
    });
    expect(
      (yield* service.discover({ cwd: repo.cwd, configuration: boundConfiguration, target }))
        .binding,
    ).toEqual({ kind: "bound", scope });
    yield* repo.git(["remote", "add", "other", "https://review.example:8443/Review/Single"]);
    const ambiguous = yield* service.discover({
      cwd: repo.cwd,
      configuration: boundConfiguration,
      target,
    });
    expect(ambiguous.binding.kind).toBe("ambiguous");
    expect(
      (yield* service.discover({
        cwd: repo.cwd,
        configuration: boundConfiguration,
        repository,
        target,
      })).binding,
    ).toEqual({ kind: "bound", scope });
  }).pipe(Effect.provide(testLayer)),
);

it.live.each(["git@review-alias:a/Team/Repo", "ssh://git@review-alias:29418/a/Team/Repo"])(
  "does not bind an SSH a/ project to its HTTP-prefix interpretation: %s",
  (url) =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const service = yield* GerritRemotes.GerritRemotes;
      yield* repo.git(["remote", "add", "review", url]);
      const exact = decodeConfiguration({
        ...configuration,
        exactBindings: [{ url, repository }],
      });
      const result = yield* service.discover({ cwd: repo.cwd, configuration: exact, target });
      expect(result.binding).toEqual({ kind: "not-bound", reason: "no-known-repository" });
      expect(result.remotes[0]?.effective.fetch).toEqual([{ kind: "unknown", transport: "ssh" }]);
    }).pipe(Effect.provide(testLayer)),
);

it.live.each(["git@review-alias:a/Team/Repo", "ssh://git@review-alias:29418/a/Team/Repo"])(
  "binds the literal SSH a/ project through the production host: %s",
  (url) =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const service = yield* GerritRemotes.GerritRemotes;
      yield* repo.git(["remote", "add", "review", url]);
      const exact = decodeConfiguration({
        ...configuration,
        exactBindings: [{ url, repository: literalRepository }],
      });
      const result = yield* service.discover({ cwd: repo.cwd, configuration: exact, target });
      expect(result.binding).toEqual({
        kind: "bound",
        scope: { ...literalRepository, branch: target },
      });
    }).pipe(Effect.provide(testLayer)),
);

it.live.each([
  "ssh://alice@review-alias:29418/Team/Repo",
  "alice@review-alias:Team/Repo",
  "ssh://john.doe@review-alias:29418/Team/Repo",
  "john.doe@review-alias:Team/Repo",
])("keeps SSH account endpoints unknown until exactly bound: %s", (url) =>
  Effect.gen(function* () {
    const repo = yield* fixture();
    const service = yield* GerritRemotes.GerritRemotes;
    yield* repo.git(["remote", "add", "review", url]);
    const unknown = yield* service.discover({ cwd: repo.cwd, configuration, target });
    const endpoint = { kind: "unknown", transport: "ssh" };
    expect(unknown.remotes).toEqual([
      {
        name: "review",
        configured: { fetch: [endpoint], push: [] },
        effective: { fetch: [endpoint], push: [endpoint] },
      },
    ]);
    expect(unknown.binding).toEqual({ kind: "not-bound", reason: "no-known-repository" });
    const exact = decodeConfiguration({
      ...configuration,
      exactBindings: [{ url, repository }],
    });
    const bound = yield* service.discover({ cwd: repo.cwd, configuration: exact, target });
    const candidate = { kind: "candidate", repositories: [repository] };
    expect(bound.remotes).toEqual([
      {
        name: "review",
        configured: { fetch: [candidate], push: [] },
        effective: { fetch: [candidate], push: [candidate] },
      },
    ]);
    expect(bound.binding).toEqual({ kind: "bound", scope });
    for (const result of [unknown, bound]) {
      expect(JSON.stringify(result)).not.toContain(url);
      expect(JSON.stringify(result)).not.toContain("alice");
      expect(JSON.stringify(result)).not.toContain("john.doe");
      expect(JSON.stringify(result)).not.toContain("review-alias");
    }
  }).pipe(Effect.provide(testLayer)),
);

it.live("deduplicates HTTP fetch and exact SSH push with reversed repository property order", () =>
  Effect.gen(function* () {
    const repo = yield* fixture();
    const service = yield* GerritRemotes.GerritRemotes;
    const url = "git@review-alias:Team/Repo";
    yield* repo.git(["remote", "add", "review", "https://review.example:8443/Review/Team/Repo"]);
    yield* repo.git(["config", "remote.review.pushurl", url]);
    const assembled = {
      confirmedInstallations: [repository.installation],
      exactBindings: [
        {
          url,
          repository: { project: repository.project, installation: repository.installation },
        },
      ],
    } satisfies GerritRemoteConfiguration;
    expect(isConfiguration(assembled)).toBe(true);
    const result = yield* service.discover({
      cwd: repo.cwd,
      configuration: assembled,
      repository,
      target,
    });
    expect(result.binding).toEqual({ kind: "bound", scope });
  }).pipe(Effect.provide(testLayer)),
);

it.live("does not infer a target from conflicting upstream settings or a detached HEAD", () =>
  Effect.gen(function* () {
    const repo = yield* fixture();
    const service = yield* GerritRemotes.GerritRemotes;
    yield* repo.git(["remote", "add", "review", "https://review.example:8443/Review/Team/Repo"]);
    yield* repo.git(["config", "--add", "branch.LocalStack.remote", "review"]);
    yield* repo.git(["config", "--add", "branch.LocalStack.remote", "other"]);
    yield* repo.git(["config", "--add", "branch.LocalStack.merge", "refs/heads/Main"]);
    yield* repo.git(["config", "--add", "branch.LocalStack.merge", "refs/heads/Other"]);
    const result = yield* service.discover({ cwd: repo.cwd, configuration });
    expect(result.binding).toEqual({ kind: "target-required", repository });
    expect(result.upstream).toEqual({
      kind: "branch",
      localBranch: "LocalStack",
      remoteNames: ["review", "other"],
      mergeBranches: ["Main", "Other"],
    });
    yield* repo.git(["checkout", "--detach", "--quiet", "HEAD"]);
    const detached = yield* service.discover({ cwd: repo.cwd, configuration });
    expect(detached.upstream).toEqual({ kind: "detached" });
    expect(detached.binding.kind).toBe("target-required");
  }).pipe(Effect.provide(testLayer)),
);

it.live("redacts credential-bearing and unsupported remote forms from results and errors", () =>
  Effect.gen(function* () {
    const repo = yield* fixture();
    const service = yield* GerritRemotes.GerritRemotes;
    const urls = [
      "https://user:private-token@review.example:8443/Review/Team/Repo",
      "https://review.example:8443/Review/Team/Repo?token=private-token",
      "ssh://user:private-token@fixture-alias/Team/Repo",
      "https://[invalid/private-token",
    ];
    for (const [index, url] of urls.entries()) {
      yield* repo.git(["remote", "add", `remote${index}`, url]);
    }
    const result = yield* service.discover({ cwd: repo.cwd, configuration, target });
    expect(result.binding.kind).toBe("not-bound");
    expect(
      result.remotes.every((remote) =>
        remote.effective.fetch.every((endpoint) => endpoint.kind === "rejected"),
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-token");
    yield* repo.git(["config", "--add", "remote.remote0.url", "https://private-token\ninvalid"]);
    const invalid = yield* Effect.result(
      service.discover({ cwd: repo.cwd, configuration, target }),
    );
    expect(invalid._tag).toBe("Failure");
    if (invalid._tag === "Failure") {
      expect(invalid.failure._tag).toBe("GerritRemoteReadError");
      expect(JSON.stringify(invalid.failure)).not.toContain("private-token");
      expect(String(invalid.failure)).not.toContain("private-token");
    }
  }).pipe(Effect.provide(testLayer)),
);

it.live(
  "fails closed on actual oversized remote configuration and succeeds after fixture repair",
  () =>
    Effect.gen(function* () {
      const repo = yield* fixture();
      const service = yield* GerritRemotes.GerritRemotes;
      yield* repo.git(["remote", "add", "review", "https://review.example:8443/Review/Team/Repo"]);
      const configPath = repo.path.join(repo.cwd, ".git/config");
      const original = yield* repo.fs.readFileString(configPath);
      yield* repo.fs.writeFileString(
        configPath,
        `${original}\n[remote "large"]\n url = https://review.example/${"x".repeat(1024 * 1024)}\n`,
      );
      const result = yield* Effect.result(
        service.discover({ cwd: repo.cwd, configuration, target }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("GitCommandError");
        if (result.failure._tag === "GitCommandError")
          expect(result.failure.outputLength).toBeGreaterThan(1024 * 1024);
      }
      yield* repo.fs.writeFileString(configPath, original);
      expect((yield* service.discover({ cwd: repo.cwd, configuration, target })).binding).toEqual({
        kind: "bound",
        scope,
      });
    }).pipe(Effect.provide(testLayer)),
);
