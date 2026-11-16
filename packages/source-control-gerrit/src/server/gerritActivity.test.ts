import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GerritComment } from "@t3tools/contracts";
import { mapGerritActivity, messageWithAccounts } from "./gerritActivity.ts";

const decodeComment = Schema.decodeUnknownSync(GerritComment);
const revision = decodeComment({
  id: "revision",
  patchSet: null,
  revision: "a".repeat(40),
  anchor: { path: null, side: "REVISION" },
  message: null,
  author: null,
  updated: "",
  inReplyTo: null,
  unresolved: null,
  visibility: "published",
}).revision!;
const comment = (overrides: Record<string, unknown>) =>
  decodeComment({
    id: "root",
    patchSet: 1,
    revision: null,
    anchor: { path: "a.ts", side: "REVISION", line: 4 },
    message: "text",
    author: { username: "alice" },
    updated: "2025-01-01 10:00:00.000000000",
    inReplyTo: null,
    unresolved: true,
    visibility: "published",
    ...overrides,
  });

describe("mapGerritActivity", () => {
  it.effect(
    "groups replies and uses the latest published resolution, regardless of input order",
    () =>
      Effect.sync(() => {
        for (const unresolved of [true, false, null]) {
          const root = comment({
            id: "root /%",
            revision,
            anchor: {
              path: "a.ts",
              side: "PARENT",
              line: 4,
              parent: 2,
              range: { start_line: 2, start_character: 0, end_line: 4, end_character: 3 },
            },
          });
          const reply = comment({
            id: "reply",
            inReplyTo: root.id,
            updated: "2025-01-02 10:00:00",
            unresolved,
          });
          const draft = comment({
            id: "draft",
            inReplyTo: reply.id,
            updated: "2025-01-03 10:00:00",
            unresolved: !unresolved,
            visibility: "server-draft",
          });
          const result = mapGerritActivity({
            messages: [],
            comments: [reply, root],
            drafts: [draft],
            portedComments: [],
          });
          expect(result.reviewThreads).toMatchObject([
            {
              id: "gerrit:root%20%2F%25",
              path: "a.ts",
              line: 4,
              side: "left",
              isResolved: unresolved === false,
              gerrit: {
                patchSet: 1,
                revision,
                parent: 2,
                range: { start_line: 2, start_character: 0, end_line: 4, end_character: 3 },
              },
              comments: [
                {
                  id: root.id,
                  gerrit: { patchSet: 1, revision, parent: 2, range: root.anchor.range },
                },
                { id: "reply", gerrit: { patchSet: 1, revision: null } },
                { id: "draft", isDraft: true, gerrit: { patchSet: 1, revision: null } },
              ],
            },
          ]);
          expect(result.gerritThreads[0]).toMatchObject({
            rootCommentId: root.id,
            resolution: unresolved === null ? "unknown" : unresolved ? "unresolved" : "resolved",
            comments: [
              { id: root.id },
              { id: "reply" },
              { id: "draft", visibility: "server-draft" },
            ],
          });
          expect(result.gerritThreads[0]?.comments[0]?.anchor).toEqual(root.anchor);
        }
      }),
  );

  it.effect("deduplicates ported comments and maps file and change-level discussions", () =>
    Effect.sync(() => {
      const file = comment({ id: "file", anchor: { path: "a.ts", side: "REVISION" } });
      const change = comment({ id: "change", anchor: { path: null, side: "REVISION" } });
      const result = mapGerritActivity({
        messages: [
          {
            id: "m",
            author: { _account_id: 42 },
            date: "2025-01-01 09:00:00",
            message: "Patch Set 2: Code-Review+1",
          },
        ],
        comments: [file, change],
        portedComments: [
          {
            id: file.id,
            original: file,
            displayAnchor: file.anchor,
            displayRevision: revision,
          },
        ],
      });
      expect(result.reviewThreads).toMatchObject([
        { id: "gerrit:change", path: "/PATCHSET_LEVEL", line: null, comments: [{ id: "change" }] },
        { path: "a.ts", line: null, comments: [{ id: "file" }] },
      ]);
      expect(result.comments).toMatchObject([
        {
          id: "m",
          author: { login: "42" },
          body: "Patch Set 2: Code-Review+1",
          createdAt: "2025-01-01T09:00:00Z",
        },
      ]);
      expect(result.gerritThreads).toHaveLength(2);
    }),
  );

  it.effect("marks draft-only threads and excludes drafts not supplied by the viewer", () =>
    Effect.sync(() => {
      const draft = comment({ id: "draft", visibility: "server-draft" });
      const result = mapGerritActivity({
        messages: [],
        comments: [draft],
        drafts: [draft],
        portedComments: [],
      });
      expect(result.reviewThreads).toMatchObject([
        {
          id: "gerrit:draft",
          isDraft: true,
          canResolve: false,
          comments: [{ id: "draft", isDraft: true }],
        },
      ]);
      expect(
        mapGerritActivity({ messages: [], comments: [draft], portedComments: [] }).reviewThreads,
      ).toEqual([]);
    }),
  );

  it.effect("keeps orphan replies together and does not claim a tied resolution", () =>
    Effect.sync(() => {
      const result = mapGerritActivity({
        messages: [],
        portedComments: [],
        comments: [
          comment({ id: "a", inReplyTo: "missing" }),
          comment({ id: "b", inReplyTo: "missing", unresolved: false }),
        ],
      });
      expect(result.gerritThreads).toMatchObject([
        { rootCommentId: "missing", resolution: "unknown" },
      ]);
      expect(result.reviewThreads[0]).toMatchObject({ isResolved: false, canResolve: false });
    }),
  );
});

it("names accounts in change messages instead of Gerrit placeholders", () => {
  expect(
    messageWithAccounts("Removed cc <GERRIT_ACCOUNT_7> and <GERRIT_ACCOUNT_8>.", {
      "7": { _account_id: 7, name: "Alvin La", username: "alvin.la" },
      "8": { _account_id: 8, username: "bob" },
    }),
  ).toBe("Removed cc Alvin La and bob.");
  expect(messageWithAccounts("Added <GERRIT_ACCOUNT_9>.", undefined)).toBe("Added account 9.");
});
