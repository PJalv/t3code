// @effect-diagnostics-next-line nodeBuiltinImport:off -- Cursors bind pagination to the exact visible comment snapshot.
import * as NodeCrypto from "node:crypto";
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
const commentCursor = Schema.fromJsonString(
  Schema.Struct({
    snapshot: Schema.String,
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);
const decodeCommentCursor = Schema.decodeUnknownEffect(commentCursor);
const encodeCommentCursor = Schema.encodeEffect(commentCursor);
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
    // A change URL names its own server and project, so reading it needs no matching checkout.
    const resolved = yield* target.resolve(
      request.mode === "search"
        ? { cwd: input.cwd }
        : "url" in request.target
          ? request.target
          : { cwd: input.cwd, ...request.target },
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
      const rawQuery = request.query?.trim();
      const result = yield* http.searchChanges({
        ...auth,
        status: rawQuery ? "all" : "open",
        project: resolved.project,
        ...(rawQuery ? { rawQuery } : {}),
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
    const activity = mapGerritActivity({
      ...detail,
      drafts: request.includeDrafts ? detail.drafts : [],
    });
    if (request.mode === "comments") {
      const comments = activity.gerritThreads.flatMap((thread) =>
        thread.comments.map((comment) => ({ ...comment, threadId: thread.id })),
      );
      const snapshot = NodeCrypto.createHash("sha256")
        .update(
          yield* encodeSnapshot({ revision: selected.commit, comments }).pipe(
            Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
          ),
        )
        .digest("hex");
      const cursor =
        request.cursor === undefined
          ? { snapshot, index: 0, offset: 0 }
          : yield* Effect.try({
              try: () => Buffer.from(request.cursor!, "base64url").toString("utf8"),
              catch: () => new GerritReadError({ reason: "invalid-input" }),
            }).pipe(
              Effect.flatMap(decodeCommentCursor),
              Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
            );
      if (
        cursor.snapshot !== snapshot ||
        cursor.index > comments.length ||
        (cursor.index === comments.length && cursor.offset !== 0)
      )
        return yield* new GerritReadError({ reason: "invalid-input" });
      const items = [];
      let { index, offset } = cursor;
      while (index < comments.length && items.length < Math.min(request.limit ?? 25, cap)) {
        const comment = comments[index]!;
        const body = comment.message ?? "";
        if (offset > body.length) return yield* new GerritReadError({ reason: "invalid-input" });
        let end = Math.min(body.length, offset + 4000);
        const last = body.charCodeAt(end - 1);
        if (end < body.length && last >= 0xd800 && last <= 0xdbff) end--;
        items.push({
          ...comment,
          message: comment.message === null ? null : body.slice(offset, end),
          bodyOffset: offset,
          messageTruncated: end < body.length,
        });
        if (end < body.length) {
          offset = end;
          break;
        }
        index++;
        offset = 0;
      }
      return {
        mode: "comments" as const,
        revision: selected.commit,
        comments: { items, truncated: index < comments.length },
        nextCursor:
          index < comments.length
            ? Buffer.from(
                yield* encodeCommentCursor({ snapshot, index, offset }).pipe(
                  Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
                ),
              ).toString("base64url")
            : null,
      };
    }
    const files = yield* http.review.readFiles({ ...reviewInput, comparison });
    const related = yield* http.getRelatedChanges({
      ...reviewInput,
      key: { ...change.key, installation },
    });
    let remainingComments = cap;
    const threads = activity.gerritThreads.map((thread) => {
      const published = thread.comments.filter((c) => c.visibility === "published");
      const root = thread.comments.find((c) => c.id === thread.rootCommentId) ?? thread.comments[0];
      const comments = thread.comments.slice(0, remainingComments).map((comment) => ({
        ...comment,
        message: comment.message?.slice(0, 4000) ?? null,
        messageTruncated: (comment.message?.length ?? 0) > 4000,
      }));
      remainingComments -= comments.length;
      return {
        id: thread.id,
        path: root?.anchor.path ?? null,
        line: root?.anchor.line ?? null,
        unresolved: thread.resolution === "unknown" ? null : thread.resolution === "unresolved",
        latestCommentId: published.at(-1)?.id ?? null,
        comments: { items: comments, truncated: comments.length < thread.comments.length },
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
