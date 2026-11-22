import { SourceControlProviderKind } from "./sourceControl.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  PullRequestDetail,
  PullRequestListResult,
  PullRequestOperationError,
  resolvePullRequestAuthorFilter,
  GERRIT_CHANGE_LEVEL_PATH,
  PullRequestDiffInput,
  PullRequestGerritDetail,
  PullRequestReviewThread,
  PullRequestSummary,
} from "./pullRequest.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

// Clients decode the detail inside the RPC's Exit, as the JSON serialization does.
const decodeDetailExit = Schema.decodeUnknownSync(
  Schema.toCodecJson(Rpc.exitSchema(WsRpcGroup.requests.get(WS_METHODS.pullRequestsDetail)!)),
);
const decodeDetail = (value: unknown): PullRequestDetail => {
  const exit = decodeDetailExit({ _tag: "Success", value });
  if (!Exit.isSuccess(exit)) throw new Error("expected a successful exit");
  return exit.value as PullRequestDetail;
};

const LIST_RESULT: PullRequestListResult = {
  viewers: { "github.com": "bilal", "gitlab.com": "bilal.hassan" },
  providers: [
    {
      host: "github.com",
      kind: SourceControlProviderKind.make("github"),
      searchesOnHost: true,
      projectCount: 1,
      configured: true,
      detail: null,
    },
    {
      host: "gitlab.com",
      kind: SourceControlProviderKind.make("gitlab"),
      searchesOnHost: true,
      projectCount: 1,
      configured: false,
      detail: "glab is not installed.",
    },
  ],
  entries: [
    {
      provider: SourceControlProviderKind.make("github"),
      host: "github.com",
      projectId: "project-1" as PullRequestListResult["entries"][number]["projectId"],
      projectTitle: "t3code",
      repository: "pingdotgg/t3code",
      number: 1,
      title: "Add a pull requests page",
      url: "https://github.com/pingdotgg/t3code/pull/1",
      author: { login: "octocat", name: null, avatarUrl: null },
      headBranch: "feat/page",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 1,
      deletions: 0,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      viewerReviewRequested: false,
      labels: [{ name: "backend", color: null }],
    },
  ],
  errors: [],
  truncated: false,
  nextCursors: { "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|1|1" },
};

describe("Gerrit pull request extensions", () => {
  it("round-trips detail and summary data without changing other providers", () => {
    const gerrit = {
      changeId: "I123",
      topic: null,
      isPrivate: true,
      isWip: false,
      currentPatchSet: 2,
      patchSets: [
        {
          number: 2,
          commit: "abc",
          createdAt: "2026-07-01T00:00:00Z",
          uploader: { _account_id: 1 },
        },
      ],
      labels: [
        {
          name: "Code-Review",
          votes: [{ account: { username: "alice" }, value: -1 }],
          permittedValues: [-2, 0, 2],
          required: true,
        },
      ],
      submitRequirements: [
        { name: "Review", status: "override" as const, description: "overridden" },
      ],
      submittable: null,
    };
    const codec = Schema.toCodecJson(PullRequestGerritDetail);
    expect(Schema.decodeSync(codec)(Schema.encodeUnknownSync(codec)(gerrit))).toStrictEqual(gerrit);
    const entry = { ...LIST_RESULT.entries[0]!, gerrit };
    const list = { ...LIST_RESULT, entries: [entry] };
    const listCodec = Schema.toCodecJson(PullRequestListResult);
    expect(Schema.decodeSync(listCodec)(Schema.encodeUnknownSync(listCodec)(list))).toStrictEqual(
      list,
    );
    const summary = { ...entry, updatedAt: entry.updatedAt };
    const summaryCodec = Schema.toCodecJson(PullRequestSummary);
    expect(
      Schema.decodeSync(summaryCodec)(Schema.encodeUnknownSync(summaryCodec)(summary)).gerrit,
    ).toStrictEqual(gerrit);
  });

  it("round-trips native anchors, drafts, and each comparison base", () => {
    const anchor = {
      patchSet: 2,
      revision: null,
      parent: 1,
      range: { start_line: 1, start_character: 0, end_line: 2, end_character: 3 },
    };
    const thread = {
      id: "gerrit:1",
      path: GERRIT_CHANGE_LEVEL_PATH,
      line: null,
      side: "right" as const,
      isResolved: false,
      isOutdated: false,
      gerrit: anchor,
      comments: [
        {
          id: "1",
          author: null,
          body: "draft",
          createdAt: "2026-07-01T00:00:00Z",
          url: null,
          gerrit: anchor,
          isDraft: true,
        },
      ],
    };
    const threadCodec = Schema.toCodecJson(PullRequestReviewThread);
    expect(
      Schema.decodeSync(threadCodec)(Schema.encodeUnknownSync(threadCodec)(thread)),
    ).toStrictEqual(thread);
    const codec = Schema.toCodecJson(PullRequestDiffInput);
    for (const base of ["base", { parent: 1 }, { patchSet: 1 }] as const) {
      const input = {
        projectId: "project-1",
        repository: "repo",
        number: 1,
        gerritComparison: { patchSet: 2, base },
      };
      expect(Schema.decodeSync(codec)(Schema.encodeUnknownSync(codec)(input))).toStrictEqual(input);
    }
  });
});

describe("PullRequestListResult", () => {
  /**
   * The RPC builds this codec at call time, so a shape it cannot lower — an open-keyed record
   * with an optional value, for one — fails as an interrupted request rather than as a schema
   * error.
   */
  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(PullRequestListResult);

    const decoded = Schema.decodeSync(codec)(Schema.encodeUnknownSync(codec)(LIST_RESULT));

    expect(decoded).toStrictEqual(LIST_RESULT);
  });
});

describe("PullRequestCapabilities", () => {
  const base = {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: true,
    review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
    reviewers: { request: true, listCandidates: true },
  };

  it("loads a newer server's detail response, dropping unknown options in order", () => {
    const options = {
      actions: ["close", "archive", "merge"],
      verdicts: ["request-changes", "block", "approve"],
      updateMethods: ["rebase", "fast-forward", "merge"],
    };
    const detail = {
      ...LIST_RESULT.entries[0],
      workspaceRoot: "/workspace/t3code",
      body: "",
      changedFiles: 1,
      mergedAt: null,
      closedAt: null,
      reviewers: [],
      checks: [],
      mergeCapabilities: { merge: true, squash: true, rebase: true },
      capabilities: {
        ...base,
        actions: options.actions,
        mergeMethods: ["squash", "semi-linear", "merge"],
        updateMethods: options.updateMethods,
        review: { ...base.review, verdicts: options.verdicts },
      },
      viewerPermissions: { ...options, comment: true, resolve: true, requestReviewers: true },
    };
    const decoded = decodeDetail(detail);
    const detailCodec = Schema.toCodecJson(PullRequestDetail);
    const withGerrit = {
      ...decoded,
      gerrit: {
        changeId: "I123",
        topic: "topic",
        isPrivate: false,
        isWip: true,
        currentPatchSet: 1,
        patchSets: [],
        labels: [],
        submitRequirements: [],
        submittable: true,
      },
    };
    expect(
      Schema.decodeSync(detailCodec)(Schema.encodeUnknownSync(detailCodec)(withGerrit)),
    ).toStrictEqual(withGerrit);

    expect(decoded.capabilities).toEqual({
      ...base,
      actions: ["close", "merge"],
      mergeMethods: ["squash", "merge"],
      updateMethods: ["rebase", "merge"],
      review: { ...base.review, verdicts: ["request-changes", "approve"] },
    });
    expect(decoded.viewerPermissions).toEqual({
      actions: ["close", "merge"],
      verdicts: ["request-changes", "approve"],
      updateMethods: ["rebase", "merge"],
      comment: true,
      resolve: true,
      requestReviewers: true,
    });
    expect(decoded.title).toBe(detail.title);
  });
});

describe("resolvePullRequestAuthorFilter", () => {
  it("reads me as the signed-in account on the host", () => {
    expect(resolvePullRequestAuthorFilter("me", "bilal")).toBe("bilal");
    expect(resolvePullRequestAuthorFilter(" @Me ", "bilal")).toBe("bilal");
  });

  it("keeps me as a literal login when the host has no viewer", () => {
    expect(resolvePullRequestAuthorFilter("me", null)).toBe("me");
    expect(resolvePullRequestAuthorFilter("@me", " ")).toBe("@me");
  });

  it("passes any other login through trimmed", () => {
    expect(resolvePullRequestAuthorFilter(" ana ", "bilal")).toBe("ana");
    expect(resolvePullRequestAuthorFilter("meredith", "bilal")).toBe("meredith");
  });
});

describe("PullRequestOperationError", () => {
  // Cloudflare swaps an origin 502 for its own body without CORS headers, so a
  // client behind a T3 Connect tunnel sees a transport error instead of this error.
  it.effect("answers with a status a Cloudflare tunnel passes through", () =>
    Effect.gen(function* () {
      const error = new PullRequestOperationError({
        operation: "diff",
        detail: "gitlab requests to gitlab.com are paused until the rate limit resets.",
      });
      const response = yield* error[HttpServerRespondable.symbol]();
      expect(response.status).not.toBe(502);
      expect(PullRequestOperationError.ast.annotations?.httpApiStatus).not.toBe(502);
    }),
  );
});
