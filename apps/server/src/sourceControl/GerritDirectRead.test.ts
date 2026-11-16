import { describe, expect, it } from "@effect/vitest";
import * as GerritHttp from "@t3tools/source-control-gerrit/server/GerritHttp";
import * as Effect from "effect/Effect";
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
          drafts: [],
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
      });
      expect(result.relationChain.items).toEqual([11, 12]);
      expect(result.files.items[0]?.inserted).toBe(1);
      expect(result.labels.items[0]?.votes.items[0]?.value).toBe(1);
      expect(result.labels.items[0]?.permittedValues.items).toEqual([-1, 0, 1]);
      expect(JSON.stringify(result)).not.toContain('"installation"');
    }).pipe(Effect.provide(layer)),
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
