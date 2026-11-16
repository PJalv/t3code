import { it } from "@effect/vitest";
import {
  GerritChangeNumber,
  GerritReadError,
  GerritChangeKey,
  GerritInstallationId,
  GitCommitOid,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as GerritHttpModule from "./GerritHttp.ts";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";
import { GerritHttp } from "./GerritHttp.ts";
import { gerritDetailPermissions, make } from "./GerritPullRequestProvider.ts";

const decodeInstallation = Schema.decodeEffect(GerritInstallationId);
const decodeNumber = Schema.decodeEffect(GerritChangeNumber);
const decodeRevision = Schema.decodeEffect(GitCommitOid);
const decodeKey = Schema.decodeEffect(GerritChangeKey);
const setup = Effect.fn("GerritProvider.test.setup")(function* () {
  const installation = yield* decodeInstallation("https://example.test/review/");
  const number = yield* decodeNumber(1);
  const revision = yield* decodeRevision("a".repeat(40));
  const key = yield* decodeKey({
    installation,
    project: "nested/project",
    branch: "main",
    changeId: `I${"b".repeat(40)}`,
  });
  const person = { name: "A", email: "a@example.test", date: "2026-01-01T00:00:00Z", tz: 0 };
  const change = {
    key,
    number,
    subject: "A",
    status: "NEW" as "NEW" | "MERGED" | "ABANDONED",
    workInProgress: false,
    isPrivate: false,
    patchSetDetails: [],
    owner: { username: "alice" },
    currentRevision: revision,
    currentPatchSet: 1,
    revisions: [{ commit: revision, patchSet: 1, parents: [], author: person, committer: person }],
  };
  const calls: number[] = [];
  const writes: Array<{ path: string; body: unknown }> = [];
  const reject = { value: false };
  const http = {
    directWrite: (_auth: unknown, path: string, _schema: unknown, write: { body: unknown }) => {
      writes.push({ path, body: write.body });
      if (reject.value) return Effect.fail(new GerritReadError({ reason: "authentication" }));
      if (path.endsWith("/review"))
        return Effect.succeed({ labels: (write.body as { labels: object }).labels });
      if (path.endsWith("/topic")) return Effect.succeed((write.body as { topic: string }).topic);
      if (path.endsWith("/message")) return Effect.succeed("ok");
      if (path.endsWith("/rebase:chain"))
        return Effect.succeed({
          rebased_changes: [
            { _number: 1, project: key.project, branch: key.branch, status: "NEW" },
          ],
        });
      if (path.endsWith("/cherrypick"))
        return Effect.succeed({
          _number: 2,
          project: key.project,
          branch: "stable",
          status: "NEW",
        });
      if (path.endsWith("/reviewers"))
        return Effect.succeed({
          input: (write.body as { reviewer: string }).reviewer,
          reviewers: [{ _account_id: 1 }],
        });
      if (/\/(submit|abandon|restore|rebase)$/.test(path))
        return Effect.succeed({
          _number: 1,
          project: key.project,
          branch: key.branch,
          status: path.endsWith("/submit")
            ? "MERGED"
            : path.endsWith("/abandon")
              ? "ABANDONED"
              : "NEW",
        });
      return Effect.void;
    },
    getChangeByNumber: () => Effect.succeed(change),
    searchChanges: (input: { offset: number; status: "open" | "merged" | "abandoned" }) => {
      calls.push(input.offset);
      const status =
        input.status === "open"
          ? ("NEW" as const)
          : input.status === "merged"
            ? ("MERGED" as const)
            : ("ABANDONED" as const);
      return Effect.succeed({
        changes: [
          {
            installation,
            project: key.project,
            branch: key.branch,
            changeId: key.changeId,
            number,
            subject: "A",
            status,
            owner: {},
            updated: person.date,
            workInProgress: true,
            ...(input.status === "open" ? { currentPatchSet: 3 } : {}),
          },
        ],
        nextOffset: input.offset + 1,
        completeness: "more" as const,
      });
    },
    review: {
      suggestReviewers: (input: { query: string }) =>
        Effect.succeed(
          input.query === "alv"
            ? [
                { _account_id: 9, username: "alvin.la", name: "Alvin La" },
                { _account_id: 7, username: "bob", name: "Bob" },
              ]
            : [],
        ),
      readReview: () =>
        Effect.succeed({
          topic: null,
          labels: {},
          reviewers: { REVIEWER: [{ _account_id: 7, username: "bob", name: "Bob" }] },
          requirements: [{ name: "Future", status: "NEW_STATUS" }],
          submittable: null,
          permittedLabels: { "Code-Review": [-1, 1, 2] },
          actions: Object.fromEntries(
            ["submit", "abandon", "restore", "wip", "ready", "rebase"].map((k) => [
              k,
              { enabled: true },
            ]),
          ),
          revisionActions: {},
          messages: [],
          comments: [
            {
              id: "root",
              patchSet: 1,
              revision,
              anchor: { path: "a.txt", side: "REVISION", line: 1 },
              message: "hello",
              author: null,
              updated: "2026-01-01T00:00:00Z",
              inReplyTo: null,
              unresolved: true,
              visibility: "published",
            },
            {
              id: "last",
              patchSet: 1,
              revision,
              anchor: { path: "a.txt", side: "REVISION", line: 1 },
              message: "reply",
              author: null,
              updated: "2026-01-02T00:00:00Z",
              inReplyTo: "root",
              unresolved: true,
              visibility: "published",
            },
          ],
          portedComments: [],
        }),
      readFiles: () =>
        Effect.succeed([
          {
            path: "/COMMIT_MSG",
            status: "A",
            oldPath: null,
            binary: false,
            inserted: 5,
            deleted: 0,
            size: null,
          },
          {
            path: "a.txt",
            status: "M",
            oldPath: null,
            binary: false,
            inserted: 1,
            deleted: 1,
            size: null,
          },
        ]),
      readDiff: () =>
        Effect.succeed({
          kind: "text",
          header: [],
          content: [{ a: ["old"], b: ["new"] }],
          oldPath: null,
          newPath: null,
        }),
    },
  } as unknown as GerritHttp["Service"];
  const api = yield* make(() =>
    Effect.succeed({
      installation: GerritInstallationId.make("https://example.test/review/"),
      credentials: Redacted.make({ username: "alice", token: "secret" }),
      credentialFingerprint: "version-1",
    }),
  ).pipe(Effect.provideService(GerritHttp, http));
  return { api, calls, writes, reject, change };
});
const input = {
  cwd: "/tmp",
  host: "https://example.test/review/",
  repository: "nested/project",
  number: 1,
};
it.effect("maps Gerrit detail permissions and retains unknown requirements", () =>
  Effect.gen(function* () {
    const { api } = yield* setup();
    const result = yield* api.getChangeRequest(input);
    expect(result.gerrit?.submitRequirements).toEqual([{ name: "Future", status: "unknown" }]);
    expect(result.gerrit?.permissions?.submit).toBe(true);
    expect(result.gerrit?.permissions?.setTopic).toBe(false);
  }),
);

it.effect("maps enabled change and revision actions conservatively", () =>
  Effect.sync(() => {
    expect(
      gerritDetailPermissions({
        actions: {
          topic: { enabled: true },
          "private.delete": { enabled: true },
          ready: { enabled: true },
          description: { enabled: true },
          abandon: { enabled: true },
          restore: { enabled: false },
        },
        revisionActions: {
          cherrypick: { enabled: true },
          rebase: { enabled: true },
          "rebase:chain": { enabled: true },
          submit: { enabled: true },
        },
      }),
    ).toEqual({
      setTopic: true,
      setPrivate: true,
      setWip: true,
      setCommitMessage: true,
      cherryPick: true,
      rebase: true,
      rebaseChain: true,
      abandon: true,
      restore: false,
      submit: true,
    });
    expect(
      Object.values(gerritDetailPermissions({ actions: {}, revisionActions: {} })).every((v) => !v),
    ).toBe(true);
    expect(
      gerritDetailPermissions({
        actions: {
          "edit-topic": { enabled: true },
          "edit-message": { enabled: true },
          private: { enabled: true },
          wip: { enabled: true },
        },
        revisionActions: {},
      }),
    ).toMatchObject({ setTopic: true, setCommitMessage: true, setPrivate: true, setWip: true });
  }),
);

it.effect("dispatches Gerrit extension commands to their endpoints", () =>
  Effect.gen(function* () {
    const { api, writes } = yield* setup();
    const gerrit = api.gerrit!;
    yield* gerrit.setVotes({ ...input, votes: { "Code-Review": 2 } });
    yield* gerrit.setTopic({ ...input, topic: "topic" });
    yield* gerrit.setPrivate({ ...input, isPrivate: true });
    yield* gerrit.setCommitMessage({
      ...input,
      message: `Subject\n\nChange-Id: I${"b".repeat(40)}`,
    });
    yield* gerrit.rebaseChain({ ...input, base: "main" });
    const picked = yield* gerrit.cherryPick({ ...input, destination: "stable" });
    expect(writes.map((write) => write.path)).toEqual([
      "changes/1/revisions/current/review",
      "changes/1/topic",
      "changes/1/private",
      "changes/1/message",
      "changes/1/rebase:chain",
      "changes/1/revisions/current/cherrypick",
    ]);
    expect(picked).toEqual({ number: 2, url: "https://example.test/review/c/nested/project/+/2" });
  }),
);

it.effect("reports the change ref as head branch and counts only real files", () =>
  Effect.gen(function* () {
    const { api } = yield* setup();
    const list = (state: "open" | "merged") =>
      api.listChangeRequests({ ...input, state, involvement: "all", viewer: "alice", limit: 10 });
    expect((yield* list("open")).items[0]?.headBranch).toBe("refs/changes/01/1/3");
    expect((yield* list("merged")).items[0]?.headBranch).toBe("refs/changes/01/1");
    const detail = yield* api.getChangeRequest(input);
    expect(detail.headBranch).toBe("refs/changes/01/1/1");
    expect(detail.changedFiles).toBe(1);
  }),
);

it.effect("maps statuses and draft while forwarding the offset cursor", () =>
  Effect.gen(function* () {
    const { api, calls } = yield* setup();
    for (const [requested, expected] of [
      ["open", "open"],
      ["merged", "merged"],
      ["closed", "closed"],
    ] as const) {
      const page = yield* api.listChangeRequests({
        ...input,
        state: requested,
        involvement: "all",
        viewer: "alice",
        limit: 10,
        cursor: { updatedBefore: "2026-01-01T00:00:00Z", delivered: 7 },
      });
      expect(page.items[0]?.state).toBe(expected);
      expect(page.items[0]?.isDraft).toBe(true);
      expect(page.continues).toBe(true);
      expect(page.cursorAdvance).toBe(1);
    }
    expect(calls).toEqual([7, 7, 7]);
  }),
);
it.effect("lists current reviewers until a search asks Gerrit for suggestions", () =>
  Effect.gen(function* () {
    const { api } = yield* setup();
    expect(yield* api.listReviewerCandidates(input)).toEqual({
      candidates: [
        { login: "bob", name: "Bob", avatarUrl: null, id: "7", kind: "user", isRequested: true },
      ],
      truncated: true,
    });
    const found = yield* api.listReviewerCandidates({ ...input, query: "alv" });
    expect(found.truncated).toBe(false);
    expect(found.candidates.map(({ id, isRequested }) => ({ id, isRequested }))).toEqual([
      { id: "9", isRequested: false },
      { id: "7", isRequested: true },
    ]);
  }),
);

it.effect("restricts votes to the exact permitted values", () =>
  Effect.gen(function* () {
    const { api } = yield* setup();
    const result = yield* api.getViewerPermissions(input);
    expect(result.verdicts).toEqual(["comment", "approve", "request-changes"]);
    expect(result.comment).toBe(true);
  }),
);
it.effect("treats a merged or abandoned change as closed to review", () =>
  Effect.gen(function* () {
    const { api, writes, change } = yield* setup();
    for (const status of ["MERGED", "ABANDONED"] as const) {
      change.status = status;
      const viewer = yield* api.getViewerPermissions(input);
      expect(viewer).toMatchObject({
        comment: false,
        resolve: false,
        verdicts: [],
        requestReviewers: false,
      });
      const detail = yield* api.getChangeRequest(input);
      expect(detail.gerrit?.labels.every((label) => label.permittedValues.length === 0)).toBe(true);
      const rejected = yield* api.comment({ ...input, body: "late" }).pipe(Effect.flip);
      expect(rejected.detail).toContain(status === "MERGED" ? "merged" : "abandoned");
      yield* api.gerrit!.setVotes({ ...input, votes: { "Code-Review": 1 } }).pipe(Effect.flip);
    }
    expect(writes).toEqual([]);
  }),
);
it.effect("maps writes and propagates rejection", () =>
  Effect.gen(function* () {
    const { api, writes, reject } = yield* setup();
    yield* api.comment({ ...input, body: "hello" });
    yield* api.submitReview({
      ...input,
      verdict: "approve",
      body: "review",
      comments: [{ path: "a.txt", body: "inline", position: { kind: "deleted", oldLine: 2 } }],
    });
    yield* api.replyToThread({ ...input, threadId: "gerrit:root", body: "reply" });
    yield* api.setThreadResolution({ ...input, threadId: "gerrit:root", resolved: false });
    yield* api.setReviewerRequest({
      ...input,
      reviewers: [{ id: "alice", kind: "user" }],
      requested: true,
    });
    yield* api.setReviewerRequest({
      ...input,
      reviewers: [{ id: "alice", kind: "user" }],
      requested: false,
    });
    for (const action of ["merge", "close", "reopen", "draft", "ready", "update-branch"] as const)
      yield* api.runAction({ ...input, action });
    expect(writes.map((w) => w.path)).toEqual([
      `changes/1/revisions/${"a".repeat(40)}/review`,
      `changes/1/revisions/${"a".repeat(40)}/review`,
      `changes/1/revisions/${"a".repeat(40)}/review`,
      `changes/1/revisions/${"a".repeat(40)}/review`,
      "changes/1/reviewers",
      "changes/1/reviewers/alice/delete",
      "changes/1/submit",
      "changes/1/abandon",
      "changes/1/restore",
      "changes/1/wip",
      "changes/1/ready",
      "changes/1/rebase",
    ]);
    expect(writes[1]?.body).toMatchObject({
      labels: { "Code-Review": 1 },
      comments: { "a.txt": [{ side: "PARENT", line: 2 }] },
    });
    expect(writes[2]?.body).toMatchObject({
      comments: { "a.txt": [{ in_reply_to: "last", unresolved: true }] },
    });
    expect(writes[3]?.body).toMatchObject({
      comments: { "a.txt": [{ in_reply_to: "last", unresolved: true }] },
    });
    reject.value = true;
    expect((yield* Effect.result(api.comment({ ...input, body: "fail" })))._tag).toBe("Failure");
    expect((yield* Effect.result(api.runAction({ ...input, action: "merge" })))._tag).toBe(
      "Failure",
    );
  }),
);
it.effect("wires diff and activity", () =>
  Effect.gen(function* () {
    const { api } = yield* setup();
    expect((yield* api.getDiff(input)).patch).toContain("-old\n+new");
    expect((yield* api.getChangeRequestActivity(input)).reviewThreads[0]?.id).toBe("gerrit:root");
  }),
);
it.effect("pages all statuses with one combined Gerrit query", () => {
  const urls: string[] = [];
  const client = HttpClient.make((request) => {
    urls.push(request.url);
    const second = new URL(request.url).searchParams.get("S") === "1";
    const row = {
      project: "nested/project",
      branch: "main",
      change_id: `I${"b".repeat(40)}`,
      _number: second ? 2 : 1,
      subject: "A",
      status: second ? "MERGED" : "NEW",
      owner: {},
      created: "2025-01-01 00:00:00.000000000",
      updated: "2026-01-01 00:00:00.000000000",
      insertions: 3,
      deletions: 2,
      ...(!second ? { _more_changes: true } : {}),
    };
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(`)]}'\n${JSON.stringify([row])}`)),
    );
  });
  return Effect.gen(function* () {
    const http = yield* GerritHttp;
    const installation = yield* decodeInstallation(input.host);
    const args = {
      installation,
      credentials: Redacted.make({ username: "alice", token: "secret" }),
      project: input.repository,
      status: "all" as const,
      limit: 1,
      offset: 0,
    };
    const first = yield* http.searchChanges(args);
    const second = yield* http.searchChanges({ ...args, offset: first.nextOffset! });
    expect(first.changes[0]).toMatchObject({
      status: "NEW",
      insertions: 3,
      deletions: 2,
      created: "2025-01-01 00:00:00.000000000",
    });
    expect(second.changes[0]?.status).toBe("MERGED");
    expect(second.completeness).toBe("complete");
    expect(new URL(urls[0]!).searchParams.get("q")).toBe(
      '(status:open OR status:merged OR status:abandoned) project:"nested/project"',
    );
    expect(new URL(urls[1]!).searchParams.get("S")).toBe("1");
  }).pipe(
    Effect.provide(GerritHttpModule.layer),
    Effect.provideService(HttpClient.HttpClient, client),
  );
});
it.effect("rejects a change from a different project", () =>
  Effect.gen(function* () {
    const { api } = yield* setup();
    const result = yield* Effect.result(
      api.getChangeRequest({ ...input, repository: "other/project" }),
    );
    expect(result._tag).toBe("Failure");
  }),
);
