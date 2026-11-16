// @effect-diagnostics effectFnOpportunity:off -- This callback adapts the git host interface.
import type { GitCommandError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import {
  GerritRemoteConfiguration,
  GerritRemoteDiscovery,
  GerritRemoteName,
  GerritRemoteRepository,
  GerritRemoteTargetBranch,
  GerritRemoteUpstream,
  resolveRemoteEndpoint,
  selectRemoteBinding,
} from "./remoteBinding.ts";

const isRemoteName = Schema.is(GerritRemoteName);
const isTargetBranch = Schema.is(GerritRemoteTargetBranch);

export class GerritRemoteReadError extends Schema.TaggedError<GerritRemoteReadError>()(
  "GerritRemoteReadError",
  {
    reason: Schema.Literals([
      "invalid-output",
      "truncated-output",
      "too-many-remotes",
      "unsupported-remote",
    ]),
  },
) {
  override get message(): string {
    return "Cannot read complete local Gerrit remote configuration.";
  }
}

export class GerritRemotes extends Context.Service<
  GerritRemotes,
  {
    readonly read: (cwd: string) => Effect.Effect<
      ReadonlyArray<{
        readonly name: string;
        readonly configured: {
          readonly fetch: ReadonlyArray<string>;
          readonly push: ReadonlyArray<string>;
        };
        readonly effective: {
          readonly fetch: ReadonlyArray<string>;
          readonly push: ReadonlyArray<string>;
        };
      }>,
      GitCommandError | GerritRemoteReadError
    >;
    readonly discover: (input: {
      readonly cwd: string;
      readonly configuration: GerritRemoteConfiguration;
      readonly repository?: GerritRemoteRepository;
      readonly target?: typeof GerritRemoteTargetBranch.Type;
    }) => Effect.Effect<typeof GerritRemoteDiscovery.Type, GitCommandError | GerritRemoteReadError>;
  }
>()("@t3tools/source-control-gerrit/server/GerritRemotes") {}

export const layer = Layer.effect(
  GerritRemotes,
  Effect.gen(function* () {
    const host = yield* SourceControlHost.SourceControlHost;
    const read = Effect.fn("GerritRemotes.read")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
    ) {
      const result = yield* host.git.execute({
        operation: "GerritRemotes.read",
        cwd,
        args: ["--no-lazy-fetch", "--no-replace-objects", "--no-optional-locks", ...args],
        maxOutputBytes: 1024 * 1024,
        appendTruncationMarker: false,
      });
      if (result.stdoutTruncated || result.stderrTruncated) {
        return yield* new GerritRemoteReadError({ reason: "truncated-output" });
      }
      if (result.exitCode !== 0)
        return yield* new GerritRemoteReadError({ reason: "invalid-output" });
      return result.stdout;
    });
    const readRemotes = Effect.fn("GerritRemotes.readRemotes")(function* (cwd: string) {
      const keys = yield* read(cwd, ["config", "--null", "--name-only", "--list"]);
      if ((keys !== "" && !keys.endsWith("\0")) || /[\r\n]/.test(keys)) {
        return yield* new GerritRemoteReadError({ reason: "unsupported-remote" });
      }
      const raw = yield* read(cwd, ["config", "--null", "--list"]);
      if (raw !== "" && !raw.endsWith("\0")) {
        return yield* new GerritRemoteReadError({ reason: "invalid-output" });
      }
      const entries =
        raw === ""
          ? []
          : raw
              .slice(0, -1)
              .split("\0")
              .map((record) => {
                const separator = record.indexOf("\n");
                return separator < 0
                  ? { key: record, value: "" }
                  : { key: record.slice(0, separator), value: record.slice(separator + 1) };
              });
      const namesInConfig = keys === "" ? [] : keys.slice(0, -1).split("\0");
      if (
        entries.length !== namesInConfig.length ||
        entries.some((entry, index) => entry.key !== namesInConfig[index])
      ) {
        return yield* new GerritRemoteReadError({ reason: "invalid-output" });
      }
      const configured = new Map<string, { fetch: string[]; push: string[] }>();
      for (const { key, value } of entries) {
        if (/^url\..*\.(?:insteadof|pushinsteadof)$/.test(key) && /[\r\n]/.test(key + value)) {
          return yield* new GerritRemoteReadError({ reason: "unsupported-remote" });
        }
        const match = /^remote\.(.+)\.(url|pushurl)$/.exec(key);
        const name = match?.[1];
        if (name === undefined) continue;
        if (!isRemoteName(name) || /[\0\r\n]/.test(value)) {
          return yield* new GerritRemoteReadError({ reason: "unsupported-remote" });
        }
        const urls = configured.get(name) ?? { fetch: [], push: [] };
        (match?.[2] === "url" ? urls.fetch : urls.push).push(value);
        configured.set(name, urls);
      }
      const namesOutput = yield* read(cwd, ["remote"]);
      const names = namesOutput === "" ? [] : namesOutput.replace(/\n$/, "").split("\n");
      if (names.length > 64)
        return yield* new GerritRemoteReadError({ reason: "too-many-remotes" });
      if (
        !names.every((name) => isRemoteName(name) && configured.has(name)) ||
        configured.size !== names.length
      ) {
        return yield* new GerritRemoteReadError({ reason: "unsupported-remote" });
      }
      const remotes = yield* Effect.forEach(
        [...configured],
        Effect.fn("GerritRemotes.readRemote")(function* ([name, urls]) {
          if (urls.fetch.length === 0)
            return yield* new GerritRemoteReadError({ reason: "unsupported-remote" });
          const fetch = yield* read(cwd, ["remote", "get-url", "--all", name]);
          const push = yield* read(cwd, ["remote", "get-url", "--push", "--all", name]);
          if (!fetch.endsWith("\n") || !push.endsWith("\n") || /[\0\r]/.test(fetch + push)) {
            return yield* new GerritRemoteReadError({ reason: "invalid-output" });
          }
          return {
            name,
            configured: urls,
            effective: {
              fetch: fetch.slice(0, -1).split("\n"),
              push: push.slice(0, -1).split("\n"),
            },
          };
        }),
      );
      return { remotes, entries };
    });
    const discover = Effect.fn("GerritRemotes.discover")(function* (
      input: Parameters<GerritRemotes["Service"]["discover"]>[0],
    ) {
      const observed = yield* readRemotes(input.cwd);
      const resolve = (url: string) => resolveRemoteEndpoint(url, input.configuration);
      const remotes = observed.remotes.map((remote) => ({
        name: remote.name,
        configured: {
          fetch: remote.configured.fetch.map(resolve),
          push: remote.configured.push.map(resolve),
        },
        effective: {
          fetch: remote.effective.fetch.map(resolve),
          push: remote.effective.push.map(resolve),
        },
      }));
      const branchOutput = yield* read(input.cwd, ["rev-parse", "--symbolic-full-name", "HEAD"]);
      const branchRef = branchOutput.replace(/\n$/, "");
      let upstream: typeof GerritRemoteUpstream.Type;
      if (branchRef === "HEAD") {
        upstream = { kind: "detached" };
      } else {
        const localBranch = branchRef.startsWith("refs/heads/") ? branchRef.slice(11) : "";
        const remoteNames = observed.entries
          .filter((entry) => entry.key === `branch.${localBranch}.remote`)
          .map((entry) => entry.value);
        const mergeRefs = observed.entries
          .filter((entry) => entry.key === `branch.${localBranch}.merge`)
          .map((entry) => entry.value);
        const mergeBranches = mergeRefs.map((ref) =>
          ref.startsWith("refs/heads/") ? ref.slice(11) : "",
        );
        // `.every()` treats an empty list as satisfied, which would claim an untracked branch
        // tracks something. Require a recorded remote and merge ref before reporting a branch.
        upstream =
          localBranch !== "" &&
          remoteNames.length > 0 &&
          mergeRefs.length > 0 &&
          isTargetBranch(localBranch) &&
          remoteNames.every(isRemoteName) &&
          mergeBranches.every(isTargetBranch)
            ? { kind: "branch", localBranch, remoteNames, mergeBranches }
            : { kind: "unsupported" };
      }
      // The tracked branch is the target only when it tracks a Gerrit remote. A caller's target
      // wins, and a local branch name is never trusted: an unpushed branch would bind a wrong scope.
      const gerritRemoteNames = new Set(
        remotes
          .filter((remote) =>
            [...remote.effective.fetch, ...remote.effective.push].some(
              (endpoint) => endpoint.kind === "candidate",
            ),
          )
          .map((remote) => remote.name),
      );
      const upstreamRepositories =
        upstream.kind === "branch"
          ? [
              ...new Map(
                remotes
                  .flatMap((remote) =>
                    upstream.remoteNames.includes(remote.name)
                      ? [...remote.effective.fetch, ...remote.effective.push].flatMap((endpoint) =>
                          endpoint.kind === "candidate" ? endpoint.repositories : [],
                        )
                      : [],
                  )
                  .map((repository) => [
                    JSON.stringify([repository.installation, repository.project]),
                    repository,
                  ]),
              ).values(),
            ]
          : [];
      const selectedRepositoryMatchesUpstream =
        input.repository === undefined ||
        upstreamRepositories.some(
          (repository) =>
            repository.installation === input.repository?.installation &&
            repository.project === input.repository?.project,
        );
      const derivedTarget =
        upstream.kind === "branch" &&
        upstream.remoteNames.length === 1 &&
        upstream.mergeBranches.length === 1 &&
        upstream.remoteNames.some((name) => gerritRemoteNames.has(name)) &&
        upstreamRepositories.length === 1 &&
        selectedRepositoryMatchesUpstream
          ? upstream.mergeBranches[0]
          : undefined;
      return {
        remotes,
        upstream,
        binding: selectRemoteBinding({
          remotes,
          ...(input.repository === undefined ? {} : { repository: input.repository }),
          ...((input.target ?? derivedTarget) === undefined
            ? {}
            : { target: (input.target ?? derivedTarget)! }),
        }),
      };
    });
    return GerritRemotes.of({
      read: (cwd) => readRemotes(cwd).pipe(Effect.map((observed) => observed.remotes)),
      discover,
    });
  }),
);
