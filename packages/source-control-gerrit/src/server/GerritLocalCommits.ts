// @effect-diagnostics processEnvInEffect:off -- Git subprocesses inherit the host environment.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import {
  GitCommitOid,
  type GitCommandError,
  type GerritRepositoryScope,
  type GerritVisibleChanges,
} from "@t3tools/contracts";
import { commitIdentity, mapLocalCommits, type LocalCommit } from "./localCommitMapping.ts";
import * as GerritRemotes from "./GerritRemotes.ts";
import type { GerritRemoteConfiguration } from "./remoteBinding.ts";
import type { GerritReadChange } from "@t3tools/contracts";

const decodeCommitOid = Schema.decodeEffect(GitCommitOid);
const decodeCommitOids = Schema.decodeEffect(Schema.Array(GitCommitOid));
const encodeContext = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeDirectories = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

export class GerritLocalReadError extends Schema.TaggedError<GerritLocalReadError>()(
  "GerritLocalReadError",
  {
    reason: Schema.Literals([
      "truncated-output",
      "invalid-output",
      "too-many-commits",
      "shallow-history",
      "grafted-history",
      "unsupported-encoding",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Cannot read the complete local Gerrit commit range.";
  }
}

export class GerritLocalCommits extends Context.Service<
  GerritLocalCommits,
  {
    readonly identity: (
      cwd: string,
    ) => Effect.Effect<string, GitCommandError | GerritLocalReadError>;
    readonly checkout: (input: {
      readonly cwd: string;
      readonly configuration: GerritRemoteConfiguration;
      readonly change: GerritReadChange;
    }) => Effect.Effect<
      {
        readonly kind: "exact-current" | "exact-older" | "local-different" | "unknown";
        readonly localOid: GitCommitOid | null;
        readonly head: GitCommitOid;
        readonly boundary: GitCommitOid;
        readonly upstreamOid: GitCommitOid;
        readonly symbolicHead: string;
        readonly context: string;
      },
      GitCommandError | GerritLocalReadError | GerritRemotes.GerritRemoteReadError
    >;
    readonly discover: (input: {
      readonly cwd: string;
      readonly base: GitCommitOid;
      readonly tip: GitCommitOid;
      readonly scope: GerritRepositoryScope;
      readonly visible: GerritVisibleChanges;
      readonly firstParent?: boolean;
    }) => Effect.Effect<
      {
        readonly commits: ReturnType<typeof mapLocalCommits>;
        readonly observation: GerritVisibleChanges;
      },
      GitCommandError | GerritLocalReadError
    >;
  }
>()("@t3tools/source-control-gerrit/server/GerritLocalCommits") {}

export const layer = Layer.effect(
  GerritLocalCommits,
  Effect.gen(function* () {
    const host = yield* SourceControlHost.SourceControlHost;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const remotes = yield* GerritRemotes.GerritRemotes.pipe(Effect.provide(GerritRemotes.layer));
    const read = Effect.fn("GerritLocalCommits.read")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
    ) {
      const result = yield* host.git.execute({
        cwd,
        operation: "GerritLocalCommits.read",
        args: ["--no-lazy-fetch", "--no-replace-objects", "--no-optional-locks", ...args],
        maxOutputBytes: 1024 * 1024,
        appendTruncationMarker: false,
      });
      if (result.exitCode !== 0) {
        return yield* new GerritLocalReadError({ reason: "invalid-output", cause: undefined });
      }
      if (result.stdoutTruncated || result.stderrTruncated) {
        return yield* new GerritLocalReadError({ reason: "truncated-output", cause: undefined });
      }
      return result.stdout;
    });
    const discover = Effect.fn("GerritLocalCommits.discover")(function* (
      input: Parameters<GerritLocalCommits["Service"]["discover"]>[0],
    ) {
      const shallow = (yield* read(input.cwd, ["rev-parse", "--is-shallow-repository"])).trim();
      if (shallow === "true") {
        return yield* new GerritLocalReadError({ reason: "shallow-history", cause: undefined });
      }
      if (shallow !== "false") {
        return yield* new GerritLocalReadError({ reason: "invalid-output", cause: undefined });
      }
      const graftPath = (yield* read(input.cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "info/grafts",
      ])).replace(/\r?\n$/, "");
      if (!path.isAbsolute(graftPath) || /[\0\r\n]/.test(graftPath)) {
        return yield* new GerritLocalReadError({ reason: "invalid-output", cause: undefined });
      }
      const grafted = yield* fs
        .exists(graftPath)
        .pipe(
          Effect.mapError((cause) => new GerritLocalReadError({ reason: "invalid-output", cause })),
        );
      if (grafted) {
        return yield* new GerritLocalReadError({ reason: "grafted-history", cause: undefined });
      }
      const listing = yield* read(input.cwd, [
        "rev-list",
        "--reverse",
        "--topo-order",
        ...(input.firstParent === true ? ["--first-parent"] : []),
        "--max-count=1001",
        input.tip,
        `^${input.base}`,
        "--",
      ]);
      const oids = yield* decodeCommitOids(
        listing.trim() === "" ? [] : listing.trim().split("\n"),
      ).pipe(
        Effect.mapError((cause) => new GerritLocalReadError({ reason: "invalid-output", cause })),
      );
      if (oids.length > 1000) {
        return yield* new GerritLocalReadError({ reason: "too-many-commits", cause: undefined });
      }
      const commits = yield* Effect.forEach(
        oids,
        Effect.fn("GerritLocalCommits.readCommit")(function* (oid) {
          const raw = yield* read(input.cwd, ["cat-file", "commit", oid]);
          const separator = raw.indexOf("\n\n");
          if (raw.includes("\0") || separator < 0) {
            return yield* new GerritLocalReadError({ reason: "invalid-output", cause: undefined });
          }
          const parentOids: string[] = [];
          for (const line of raw.slice(0, separator).split("\n").slice(1)) {
            if (!line.startsWith("parent ")) break;
            parentOids.push(line.slice(7));
          }
          const parents = yield* decodeCommitOids(parentOids).pipe(
            Effect.mapError(
              (cause) => new GerritLocalReadError({ reason: "invalid-output", cause }),
            ),
          );
          const headers = raw.slice(0, separator).split(/\n(?! )/);
          if (
            headers.some(
              (header) => /^encoding\b/.test(header) && !/^encoding (?:UTF-8|UTF8)$/i.test(header),
            )
          ) {
            return yield* new GerritLocalReadError({
              reason: "unsupported-encoding",
              cause: undefined,
            });
          }
          const message = raw.slice(separator + 2);
          return { oid, parents, message } satisfies LocalCommit;
        }),
      );
      return {
        commits: mapLocalCommits({ commits, scope: input.scope, visible: input.visible }),
        observation: input.visible,
      };
    });
    const identity = Effect.fn("GerritLocalCommits.identity")(function* (cwd: string) {
      const directories = yield* Effect.forEach(
        ["--absolute-git-dir", "--git-common-dir"],
        (flag) =>
          read(cwd, ["rev-parse", "--path-format=absolute", flag]).pipe(
            Effect.flatMap((output) => {
              const directory = output.replace(/\r?\n$/, "");
              if (!path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) {
                return Effect.fail(
                  new GerritLocalReadError({ reason: "invalid-output", cause: undefined }),
                );
              }
              return Effect.gen(function* () {
                const canonical = yield* fs.realPath(directory);
                const info = yield* fs.stat(canonical);
                if (info.type !== "Directory" || Option.isNone(info.ino))
                  return yield* new GerritLocalReadError({
                    reason: "invalid-output",
                    cause: undefined,
                  });
                return `${canonical}\0${info.dev}\0${info.ino.value}\0${Option.getOrNull(info.birthtime)?.toISOString() ?? "unknown"}`;
              }).pipe(
                Effect.mapError(
                  (cause) => new GerritLocalReadError({ reason: "invalid-output", cause }),
                ),
              );
            }),
          ),
      );
      return yield* encodeDirectories(directories).pipe(
        Effect.mapError((cause) => new GerritLocalReadError({ reason: "invalid-output", cause })),
      );
    });
    const checkout = Effect.fn("GerritLocalCommits.checkout")(function* (
      input: Parameters<GerritLocalCommits["Service"]["checkout"]>[0],
    ) {
      const invalid = () =>
        new GerritLocalReadError({ reason: "invalid-output", cause: undefined });
      const capture = Effect.fn("GerritLocalCommits.captureCheckout")(function* () {
        const cwd = yield* fs.realPath(input.cwd).pipe(Effect.mapError(invalid));
        const root = (yield* read(cwd, ["rev-parse", "--show-toplevel"])).replace(/\n$/, "");
        if (cwd !== (yield* fs.realPath(root).pipe(Effect.mapError(invalid))))
          return yield* invalid();
        if ((yield* read(cwd, ["rev-parse", "--is-shallow-repository"])).trim() !== "false")
          return yield* invalid();
        const graftPath = (yield* read(cwd, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "info/grafts",
        ])).replace(/\n$/, "");
        if (
          !path.isAbsolute(graftPath) ||
          /[\0\r\n]/.test(graftPath) ||
          (yield* fs.exists(graftPath).pipe(Effect.mapError(invalid)))
        )
          return yield* invalid();
        const repository = yield* identity(cwd);
        const head = yield* decodeCommitOid(
          (yield* read(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim(),
        ).pipe(Effect.mapError(invalid));
        const symbolicHead = (yield* read(cwd, ["symbolic-ref", "HEAD"])).trim();
        if (!symbolicHead.startsWith("refs/heads/") || /[\0\r\n]/.test(symbolicHead))
          return yield* invalid();
        const discovery = yield* remotes.discover({ cwd, configuration: input.configuration });
        const upstream = discovery.upstream;
        if (
          upstream.kind !== "branch" ||
          upstream.remoteNames.length !== 1 ||
          upstream.mergeBranches.length !== 1 ||
          upstream.mergeBranches[0] !== input.change.key.branch ||
          symbolicHead !== `refs/heads/${upstream.localBranch}`
        )
          return yield* invalid();
        const remoteName = upstream.remoteNames[0];
        const remote = discovery.remotes.find((candidate) => candidate.name === remoteName);
        if (remote === undefined) return yield* invalid();
        const endpoints = [...remote.configured.fetch, ...remote.effective.fetch];
        if (
          endpoints.length !== 2 ||
          endpoints.some(
            (endpoint) =>
              endpoint.kind !== "candidate" ||
              endpoint.repositories.length !== 1 ||
              endpoint.repositories[0]?.installation !== input.change.key.installation ||
              endpoint.repositories[0]?.project !== input.change.key.project,
          )
        )
          return yield* invalid();
        const config = yield* read(cwd, ["config", "--null", "--list"]);
        if (!config.endsWith("\0")) return yield* invalid();
        const entries = config
          .slice(0, -1)
          .split("\0")
          .map((record) => {
            const separator = record.indexOf("\n");
            return { key: record.slice(0, separator), value: record.slice(separator + 1) };
          });
        const mapping = entries
          .filter((entry) => entry.key === `remote.${remoteName}.fetch`)
          .map((entry) => entry.value);
        const trackingRef = `refs/remotes/${remoteName}/${input.change.key.branch}`;
        const mergeRef = `refs/heads/${input.change.key.branch}`;
        if (
          entries.some(
            (entry) =>
              /^remote\..+\.fetch$/.test(entry.key) &&
              entry.key !== `remote.${remoteName}.fetch` &&
              (() => {
                const parts = entry.value.split(":");
                if (parts.length !== 2 || !parts[1]) return true;
                const destination = parts[1];
                const wildcard = destination.indexOf("*");
                if (wildcard < 0) return destination === trackingRef;
                if (wildcard !== destination.lastIndexOf("*")) return true;
                return (
                  trackingRef.startsWith(destination.slice(0, wildcard)) &&
                  trackingRef.endsWith(destination.slice(wildcard + 1))
                );
              })(),
          )
        )
          return yield* invalid();
        if (
          mapping.length !== 1 ||
          (mapping[0] !== `+refs/heads/*:refs/remotes/${remoteName}/*` &&
            mapping[0] !== `${mergeRef}:${trackingRef}` &&
            mapping[0] !== `+${mergeRef}:${trackingRef}`)
        )
          return yield* invalid();
        const resolved = (yield* read(cwd, [
          "rev-parse",
          "--symbolic-full-name",
          "@{upstream}",
        ])).trim();
        if (resolved !== trackingRef) return yield* invalid();
        const upstreamOid = yield* decodeCommitOid(
          (yield* read(cwd, ["rev-parse", "--verify", `${trackingRef}^{commit}`])).trim(),
        ).pipe(Effect.mapError(invalid));
        const bases = yield* decodeCommitOids(
          (yield* read(cwd, ["merge-base", "--all", head, upstreamOid])).trim().split("\n"),
        ).pipe(Effect.mapError(invalid));
        const boundary = bases[0];
        if (bases.length !== 1 || boundary === undefined) return yield* invalid();
        return { cwd, repository, head, symbolicHead, upstreamOid, boundary, discovery, config };
      });
      if (process.env.GIT_GRAFT_FILE !== undefined || process.env.GIT_SHALLOW_FILE !== undefined)
        return yield* invalid();
      const before = yield* capture();
      const range = yield* discover({
        cwd: before.cwd,
        base: before.boundary,
        tip: before.head,
        scope: input.change.key,
        firstParent: true,
        visible: {
          changes: [],
          completeness: "complete-visible",
          observedAt: "2026-01-01T00:00:00.000Z",
        },
      });
      let parent = before.boundary;
      for (const commit of range.commits) {
        if (
          commit.parents.length !== 1 ||
          commit.parents[0] !== parent ||
          commit.mapping.kind === "invalid"
        )
          return yield* invalid();
        parent = commit.oid;
      }
      if (parent !== before.head) return yield* invalid();
      const matching = range.commits.filter((commit) => {
        const parsed = commitIdentity(commit.message);
        return parsed.kind === "valid" && parsed.changeId === input.change.key.changeId;
      });
      const after = yield* capture();
      const context = yield* encodeContext(before).pipe(Effect.mapError(invalid));
      if (context !== (yield* encodeContext(after).pipe(Effect.mapError(invalid))))
        return yield* invalid();
      const local = matching.length === 1 ? matching[0] : undefined;
      const revisions =
        local === undefined
          ? []
          : input.change.revisions.filter((revision) => revision.commit === local.oid);
      const current = input.change.revisions.filter(
        (revision) => revision.commit === input.change.currentRevision,
      );
      if (
        current.length !== 1 ||
        current[0]?.patchSet !== input.change.currentPatchSet ||
        (revisions[0] !== undefined &&
          revisions[0].commit !== input.change.currentRevision &&
          revisions[0].patchSet >= input.change.currentPatchSet)
      )
        return yield* invalid();
      const kind: Effect.Success<ReturnType<GerritLocalCommits["Service"]["checkout"]>>["kind"] =
        local === undefined
          ? "unknown"
          : revisions.length === 1
            ? local.oid === input.change.currentRevision
              ? "exact-current"
              : "exact-older"
            : revisions.length === 0
              ? "local-different"
              : "unknown";
      return {
        kind,
        localOid: local?.oid ?? null,
        head: before.head,
        boundary: before.boundary,
        upstreamOid: before.upstreamOid,
        symbolicHead: before.symbolicHead,
        context,
      };
    });
    return GerritLocalCommits.of({ discover, identity, checkout });
  }),
);
