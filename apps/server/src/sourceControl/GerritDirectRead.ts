import {
  GerritChangeNumber,
  GerritDirectReadRequest,
  GerritInstallationId,
  GerritReadError,
  gerritDirectDecodeOptions,
} from "@t3tools/contracts";
import * as GerritHttp from "@t3tools/source-control-gerrit/server/GerritHttp";
import { mapGerritActivity } from "@t3tools/source-control-gerrit/server/gerritActivity";
import { renderGerritUnifiedDiff } from "@t3tools/source-control-gerrit/server/gerritUnifiedDiff";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as GerritTarget from "./GerritTarget.ts";

const cap = 100;
const bounded = <T>(items: ReadonlyArray<T>) => ({
  items: items.slice(0, cap),
  truncated: items.length > cap,
});
const decode = Schema.decodeUnknownEffect(GerritDirectReadRequest, gerritDirectDecodeOptions);

const make = Effect.gen(function* () {
  const target = yield* GerritTarget.GerritTarget;
  const http = yield* GerritHttp.GerritHttp;
  const read = Effect.fn("GerritDirectRead.read")(function* (input: {
    readonly cwd: string;
    readonly request: GerritDirectReadRequest;
  }) {
    const request = yield* decode(input.request).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    const resolved = yield* target.resolve(
      request.mode === "search" ? { cwd: input.cwd } : { cwd: input.cwd, ...request.target },
    );
    const credentials = yield* target.credentials(resolved.server);
    const installation = GerritInstallationId.make(resolved.server);
    const auth = { installation, credentials };
    if (request.mode === "search") {
      const offset = request.cursor === undefined ? 0 : Number(request.cursor);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 10000 ||
        (request.cursor !== undefined && !/^(0|[1-9]\d*)$/.test(request.cursor))
      )
        return yield* new GerritReadError({ reason: "invalid-input" });
      const result = yield* http.searchChanges({
        ...auth,
        status: "open",
        project: resolved.project,
        ...(request.query ? { search: request.query } : {}),
        limit: Math.min(request.limit ?? 25, 100),
        offset,
      });
      return {
        mode: "search" as const,
        changes: result.changes.map(({ installation: _installation, ...change }) => change),
        nextCursor: result.nextOffset === null ? null : String(result.nextOffset),
        completeness: result.completeness,
      };
    }
    if (resolved.number === undefined)
      return yield* new GerritReadError({ reason: "invalid-input" });
    const number = GerritChangeNumber.make(resolved.number);
    const change = yield* http.getChangeByNumber({ ...auth, number });
    if (change.key.project !== resolved.project)
      return yield* new GerritReadError({ reason: "identity-mismatch" });
    const revisionInput = request.mode === "reviewers" ? undefined : request.revision;
    const selected =
      revisionInput === undefined
        ? change.revisions.find((r) => r.commit === change.currentRevision)
        : change.revisions.find(
            (r) => r.commit === revisionInput || String(r.patchSet) === revisionInput,
          );
    if (!selected) return yield* new GerritReadError({ reason: "invalid-input" });
    const reviewInput = { ...auth, key: change.key, number, revision: selected.commit };
    if (request.mode === "reviewers") {
      const candidates = yield* http.review.suggestReviewers({
        ...reviewInput,
        query: request.query,
        state: "REVIEWER",
      });
      const limit = Math.min(request.limit ?? 20, 20);
      return {
        mode: "reviewers" as const,
        candidates: candidates.slice(0, limit).map((a) => ({
          id: a._account_id,
          name: a.name ?? a.display_name ?? null,
          email: a.email ?? null,
        })),
        truncated: candidates.length > limit,
      };
    }
    const base =
      request.mode === "diff" && request.base !== undefined
        ? change.revisions.find(
            (r) => r.commit === request.base || String(r.patchSet) === request.base,
          )
        : undefined;
    if (request.mode === "diff" && request.base !== undefined && !base)
      return yield* new GerritReadError({ reason: "invalid-input" });
    const comparison = base
      ? { kind: "revision" as const, revision: base.commit }
      : { kind: "base" as const };
    if (request.mode === "diff") {
      const files = yield* http.review.readFiles({ ...reviewInput, comparison });
      const file = files.find((f) => f.path === request.path);
      if (!file) return yield* new GerritReadError({ reason: "not-found-or-hidden" });
      const diff = yield* http.review.readDiff({ ...reviewInput, comparison, path: request.path });
      return { mode: "diff" as const, ...renderGerritUnifiedDiff([{ ...file, diff }]) };
    }
    const detail = yield* http.review.readReview(reviewInput);
    const files = yield* http.review.readFiles({ ...reviewInput, comparison });
    const related = yield* http.getRelatedChanges({
      ...reviewInput,
      key: { ...change.key, installation },
    });
    const activity = mapGerritActivity({
      ...detail,
      ...(request.includeDrafts ? { drafts: detail.drafts } : { drafts: [] }),
    });
    const threads = activity.gerritThreads.map((thread) => {
      const published = thread.comments.filter((c) => c.visibility === "published");
      const root = thread.comments.find((c) => c.id === thread.rootCommentId) ?? thread.comments[0];
      return {
        id: thread.id,
        path: root?.anchor.path ?? null,
        line: root?.anchor.line ?? null,
        unresolved: thread.resolution === "unknown" ? null : thread.resolution === "unresolved",
        latestCommentId: published.at(-1)?.id ?? null,
      };
    });
    return {
      mode: "change" as const,
      number,
      url: `${resolved.server.replace(/\/$/, "")}/c/${change.key.project.split("/").map(encodeURIComponent).join("/")}/+/${number}`,
      project: change.key.project,
      branch: change.key.branch,
      status: change.status,
      subject: change.subject,
      owner: change.owner,
      topic: detail.topic,
      workInProgress: change.workInProgress,
      private: change.isPrivate,
      currentPatchSet: change.currentPatchSet,
      currentRevision: change.currentRevision,
      revisions: bounded(change.revisions.map(({ patchSet, commit }) => ({ patchSet, commit }))),
      labels: bounded(
        Object.entries(detail.labels).map(([name, label]) => ({
          name,
          votes: bounded(label.all ?? []),
          permittedValues: bounded(detail.permittedLabels[name] ?? []),
          values: label.values ?? {},
        })),
      ),
      actions: detail.actions,
      revisionActions: detail.revisionActions,
      reviewers: bounded(detail.reviewers.REVIEWER ?? []),
      ccs: bounded(detail.reviewers.CC ?? []),
      requirements: detail.requirements === null ? null : bounded(detail.requirements),
      submittable: detail.submittable,
      messages: bounded(detail.messages),
      threads: bounded(threads),
      relationChain: bounded(
        related.revisions.flatMap((r) => (r.number === undefined ? [] : [r.number])),
      ),
      relationCompleteness: related.completeness,
      files: bounded(files),
    };
  });
  return { read };
});

export class GerritDirectRead extends Context.Service<
  GerritDirectRead,
  Effect.Success<typeof make>
>()("t3/sourceControl/GerritDirectRead") {}
export const layer = Layer.effect(GerritDirectRead, make);
