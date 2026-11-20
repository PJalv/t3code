import { describe, expect, it } from "@effect/vitest";
import * as GerritHttp from "@t3tools/source-control-gerrit/server/GerritHttp";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as GerritDirectRead from "./GerritDirectRead.ts";
import * as GerritTarget from "./GerritTarget.ts";

const oid = "a".repeat(40);
const change = {
  key: { project: "team/repo", branch: "main", changeId: "I" + "b".repeat(40) },
  number: 12,
  subject: "Subject",
  status: "NEW",
  workInProgress: false,
  owner: { name: "Owner" },
  currentRevision: oid,
  currentPatchSet: 1,
  revisions: [{ commit: oid, patchSet: 1 }],
  isPrivate: false,
};
const file = {
  path: "a.txt",
  status: "M",
  inserted: 1,
  deleted: 1,
  oldPath: null,
  binary: false,
  size: 10,
};
const comment = {
  id: "c1",
  anchor: { path: "a.txt", line: 3, side: "REVISION" },
  updated: "2025-01-01 00:00:00",
  inReplyTo: null,
  unresolved: true,
  visibility: "published",
  message: "Please fix the commit message",
  author: { name: "Alvin", username: "alvin" },
  patchSet: 1,
  revision: oid,
};
const draft = {
  ...comment,
  id: "draft",
  inReplyTo: "c1",
  visibility: "server-draft",
  message: "Draft reply",
};
const dependencies = Layer.mergeAll(
  Layer.succeed(GerritTarget.GerritTarget, {
    resolve: () =>
      Effect.succeed({ server: "https://review.example/", project: "team/repo", number: 12 }),
    credentials: () => Effect.succeed({}),
  } as never),
  Layer.succeed(GerritHttp.GerritHttp, {
    getChangeByNumber: () => Effect.succeed(change),
    getRelatedChanges: () =>
      Effect.succeed({
        revisions: [{ number: 11, installation: "hidden" }, { number: 12 }],
        completeness: "complete-visible",
      }),
    searchChanges: () =>
      Effect.succeed({
        changes: [{ installation: "hidden", number: 12, subject: "Subject" }],
        nextOffset: 25,
        completeness: "more",
      }),
    review: {
      readReview: () =>
        Effect.succeed({
          topic: null,
          reviewers: { REVIEWER: [{ name: "Reviewer" }], CC: [] },
          labels: { "Code-Review": { all: [{ name: "Reviewer", value: 1 }] } },
          permittedLabels: { "Code-Review": [-1, 0, 1] },
          actions: {},
          revisionActions: {},
          requirements: [],
          submittable: true,
          messages: [],
          comments: [comment],
          drafts: [draft],
          portedComments: [],
        }),
      readFiles: () => Effect.succeed([file]),
      readDiff: () =>
        Effect.succeed({ kind: "text", oldPath: null, content: [{ a: ["old"], b: ["new"] }] }),
      suggestReviewers: () =>
        Effect.succeed([{ _account_id: 2, name: "Reviewer", email: "r@example.com" }]),
    },
  } as never),
);
const layer = GerritDirectRead.layer.pipe(Layer.provide(dependencies));

describe("GerritDirectRead", () => {
  it.effect("reads a compact change and its threads", () =>
    Effect.gen(function* () {
      const service = yield* GerritDirectRead.GerritDirectRead;
      const result = yield* service.read({
        cwd: "/repo",
        request: { mode: "change", target: { number: 12 } },
      });
      expect(result.mode).toBe("change");
      if (result.mode !== "change") throw new Error("wrong mode");
      expect(result.threads.items[0]).toEqual({
        id: "gerrit:c1",
        path: "a.txt",
        line: 3,
        unresolved: true,
        latestCommentId: "c1",
        comments: { items: [{ ...comment, messageTruncated: false }], truncated: false },
      });
      const withDrafts = yield* service.read({
        cwd: "/repo",
        request: { mode: "change", target: { number: 12 }, includeDrafts: true },
      });
      if (withDrafts.mode !== "change") throw new Error("wrong mode");
      expect(withDrafts.threads.items[0]?.comments.items).toEqual([
        { ...comment, messageTruncated: false },
        { ...draft, messageTruncated: false },
      ]);
      expect(result.relationChain.items).toEqual([11, 12]);
      expect(result.files.items[0]?.inserted).toBe(1);
      expect(result.labels.items[0]?.votes.items[0]?.value).toBe(1);
      expect(result.labels.items[0]?.permittedValues.items).toEqual([-1, 0, 1]);
      expect(JSON.stringify(result)).not.toContain('"installation"');
    }).pipe(Effect.provide(layer)),
  );
  it.effect("retrieves every comment and long body segment without exposing drafts", () =>
    Effect.gen(function* () {
      const comments = Array.from({ length: 102 }, (_, index) => ({
        ...comment,
        id: `comment-${index}`,
        inReplyTo: null,
        message: index === 0 ? `${"a".repeat(3999)}😀${"b".repeat(100)}` : `Feedback ${index}`,
      }));
      let current = comments;
      const http = {
        getChangeByNumber: () => Effect.succeed(change),
        review: {
          readReview: () =>
            Effect.succeed({
              messages: [],
              comments: current,
              drafts: [draft],
              portedComments: [],
            }),
        },
      };
      const service = yield* Layer.build(
        GerritDirectRead.layer.pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(GerritTarget.GerritTarget, {
                resolve: () =>
                  Effect.succeed({
                    server: "https://review.example/",
                    project: "team/repo",
                    number: 12,
                  }),
                credentials: () => Effect.succeed({}),
              } as never),
              Layer.succeed(GerritHttp.GerritHttp, http as never),
            ),
          ),
        ),
      ).pipe(Effect.map((context) => Context.get(context, GerritDirectRead.GerritDirectRead)));
      const bodies = new Map<string, string>();
      let cursor: string | undefined;
      let firstCursor: string | null = null;
      do {
        const result = yield* service.read({
          cwd: "/repo",
          request: {
            mode: "comments",
            target: { number: 12 },
            limit: 17,
            ...(cursor ? { cursor } : {}),
          },
        });
        if (result.mode !== "comments") throw new Error("wrong mode");
        expect(result.comments.items[0]?.id).not.toBe("c1");
        for (const entry of result.comments.items) {
          expect(entry.visibility).toBe("published");
          expect(entry.message?.length ?? 0).toBeLessThanOrEqual(4000);
          expect(entry.bodyOffset).toBe((bodies.get(entry.id) ?? "").length);
          bodies.set(entry.id, (bodies.get(entry.id) ?? "") + entry.message);
        }
        firstCursor ??= result.nextCursor;
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      expect(bodies.size).toBe(102);
      for (const entry of comments) expect(bodies.get(entry.id)).toBe(entry.message);
      current = comments.slice(1);
      expect(
        Result.isFailure(
          yield* Effect.result(
            service.read({
              cwd: "/repo",
              request: { mode: "comments", target: { number: 12 }, cursor: firstCursor! },
            }),
          ),
        ),
      ).toBe(true);
      expect(
        Result.isFailure(
          yield* Effect.result(
            service.read({
              cwd: "/repo",
              request: { mode: "comments", target: { number: 12 }, cursor: "invalid" },
            }),
          ),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );
  it.effect("resolves a change URL without the checkout", () =>
    Effect.gen(function* () {
      const inputs: Array<GerritTarget.TargetInput> = [];
      const service = yield* Layer.build(
        GerritDirectRead.layer.pipe(
          Layer.provide(
            Layer.merge(
              dependencies,
              Layer.succeed(GerritTarget.GerritTarget, {
                resolve: (input: GerritTarget.TargetInput) => {
                  inputs.push(input);
                  return Effect.succeed({
                    server: "https://review.example/",
                    project: "team/repo",
                    number: 12,
                  });
                },
                credentials: () => Effect.succeed({}),
              } as never),
            ),
          ),
        ),
      ).pipe(Effect.map((context) => Context.get(context, GerritDirectRead.GerritDirectRead)));
      const url = "https://review.example/c/team/repo/+/12";
      yield* service.read({ cwd: "/repo", request: { mode: "change", target: { url } } });
      yield* service.read({ cwd: "/repo", request: { mode: "change", target: { number: 12 } } });
      expect(inputs).toEqual([{ url }, { cwd: "/repo", number: 12 }]);
    }).pipe(Effect.scoped),
  );
  it.effect("renders a file diff", () =>
    Effect.gen(function* () {
      const service = yield* GerritDirectRead.GerritDirectRead;
      const result = yield* service.read({
        cwd: "/repo",
        request: { mode: "diff", target: { number: 12 }, path: "a.txt", revision: "1" },
      });
      expect(result.mode).toBe("diff");
      if (result.mode !== "diff") throw new Error("wrong mode");
      expect(result.patch).toContain("-old\n+new");
      expect(JSON.stringify(result)).not.toContain('"installation"');
    }).pipe(Effect.provide(layer)),
  );
  it.effect("suggests reviewers", () =>
    Effect.gen(function* () {
      const service = yield* GerritDirectRead.GerritDirectRead;
      const result = yield* service.read({
        cwd: "/repo",
        request: { mode: "reviewers", target: { number: 12 }, query: "Rev" },
      });
      expect(result.mode).toBe("reviewers");
      if (result.mode !== "reviewers") throw new Error("wrong mode");
      expect(result.candidates).toEqual([{ id: 2, name: "Reviewer", email: "r@example.com" }]);
      expect(JSON.stringify(result)).not.toContain('"installation"');
    }).pipe(Effect.provide(layer)),
  );
  it.effect("pages search results without exposing installation", () =>
    Effect.gen(function* () {
      const service = yield* GerritDirectRead.GerritDirectRead;
      const result = yield* service.read({ cwd: "/repo", request: { mode: "search" } });
      expect(result.mode).toBe("search");
      if (result.mode !== "search") throw new Error("wrong mode");
      expect(result.nextCursor).toBe("25");
      expect(JSON.stringify(result)).not.toContain('"installation"');
      const invalid = yield* Effect.result(
        service.read({ cwd: "/repo", request: { mode: "search", cursor: "bad" } }),
      );
      expect(Result.isFailure(invalid)).toBe(true);
      const excess = yield* Effect.result(
        service.read({
          cwd: "/repo",
          request: { mode: "search", installation: "unwanted" } as never,
        }),
      );
      expect(Result.isFailure(excess)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
});
