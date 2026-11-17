import {
  GerritChangeNumber,
  GerritInstallationId,
  SourceControlProviderKind,
  type GerritAccount,
  type GerritReadChange,
  type GerritReviewDetail,
} from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GerritHttp, type GerritHttpCredentials } from "./GerritHttp.ts";
import { makeDirectActions } from "./GerritDirectActions.ts";
import { mapGerritActivity } from "./gerritActivity.ts";
import { gerritAccountActor as actor } from "./gerritAccount.ts";
import { renderGerritUnifiedDiff } from "./gerritUnifiedDiff.ts";

export type GerritCredentialResolver = (serverUrl: string) => Effect.Effect<
  {
    readonly installation: GerritInstallationId;
    readonly credentials: GerritHttpCredentials;
    readonly credentialFingerprint: string;
    readonly checksProfile?: "checks-rest-v1-3.10";
  },
  PullRequestProviderError
>;

const decodeNumber = Schema.decodeEffect(GerritChangeNumber);
const encodeFingerprint = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const kind = SourceControlProviderKind.make("gerrit");
const error = (operation: string, detail: string) =>
  new PullRequestProviderError({ provider: kind, operation, reason: "failed", detail });
const unsupported = (operation: string) =>
  Effect.fail(error(operation, "Gerrit operation is not yet supported."));
const state = (status: GerritReadChange["status"]) =>
  status === "NEW"
    ? ("open" as const)
    : status === "MERGED"
      ? ("merged" as const)
      : ("closed" as const);
const mapChecks = (
  checks: Extract<GerritReviewDetail["checks"], { kind: "available" }>["values"],
) =>
  checks.map((c) => ({
    name: c.checker_name || c.checker_uuid,
    status:
      c.state === "SUCCESSFUL"
        ? ("success" as const)
        : c.state === "FAILED"
          ? ("failure" as const)
          : c.state === "NOT_RELEVANT"
            ? ("skipped" as const)
            : ("pending" as const),
    description: c.message ?? null,
    url: c.url ?? null,
  }));
const url = (server: string, project: string, number: number) =>
  `${server}c/${project.split("/").map(encodeURIComponent).join("/")}/+/${number}`;
// Gerrit changes have no head branch; their fetchable ref is the closest equivalent. Older
// servers can omit the patch set from search results, leaving only the change's ref namespace.
const changeRef = (number: number, patchSet: number | null | undefined) => {
  const prefix = `refs/changes/${String(number % 100).padStart(2, "0")}/${number}`;
  return patchSet == null ? prefix : `${prefix}/${patchSet}`;
};
const timestamp = (value: string) => value.replace(" ", "T").replace(/(\d)$/, "$1Z");
// Gerrit has no source branch. The empty string denotes an unknown branch, not a patch-set ref.
const baseRow = (
  server: string,
  c: {
    project: string;
    branch: string;
    number: number;
    subject: string;
    status: GerritReadChange["status"];
    workInProgress: boolean;
    owner: typeof GerritAccount.Type;
    created?: string | undefined;
    insertions?: number | undefined;
    deletions?: number | undefined;
    currentPatchSet?: number | null | undefined;
    submittable?: boolean | undefined;
    reviewStatus?: GerritReadChange["reviewStatus"] | undefined;
  },
  updated: string,
): ProviderChangeRequest => ({
  number: c.number,
  title: c.subject,
  url: url(server, c.project, c.number),
  author: actor(c.owner),
  headBranch: changeRef(c.number, c.currentPatchSet),
  baseBranch: c.branch,
  state: state(c.status),
  isDraft: c.workInProgress,
  mergeability: "unknown",
  additions: c.insertions ?? 0,
  deletions: c.deletions ?? 0,
  createdAt: timestamp(c.created ?? updated),
  updatedAt: timestamp(updated),
  reviewRequestLogins: [],
  labels: [],
  ...(c.submittable === undefined ? {} : { gerritSubmittable: c.submittable }),
  ...(c.reviewStatus === undefined ? {} : { reviewDecision: c.reviewStatus }),
});
export const gerritDetailPermissions = (
  review: Pick<GerritReviewDetail, "actions" | "revisionActions">,
) => {
  const enabled = (...keys: string[]) =>
    keys.some(
      (key) =>
        review.actions[key]?.enabled === true || review.revisionActions[key]?.enabled === true,
    );
  return {
    setTopic: enabled("topic", "edit-topic"),
    setPrivate: enabled("private", "private.delete"),
    setWip: enabled("wip", "ready"),
    setCommitMessage: enabled("description", "message", "edit-message"),
    cherryPick: enabled("cherrypick"),
    rebase: enabled("rebase"),
    rebaseChain: enabled("rebase:chain"),
    abandon: enabled("abandon"),
    restore: enabled("restore"),
    submit: enabled("submit"),
  };
};

// Gerrit still accepts comments and post-submit votes on a merged or abandoned change, but the
// review is over: T3 treats closed changes as read-only so neither a person nor an agent reopens it.
const reviewOpen = (change: Pick<GerritReadChange, "status">) => change.status === "NEW";

const permissions = (review: GerritReviewDetail, change: Pick<GerritReadChange, "status">) => ({
  stackRebase: false,
  actions: (
    [
      ["merge", "submit"],
      ["close", "abandon"],
      ["reopen", "restore"],
      ["draft", "wip"],
      ["ready", "ready"],
      ["update-branch", "rebase"],
    ] as const
  ).flatMap(([action, key]) =>
    review.actions?.[key]?.enabled || review.revisionActions?.[key]?.enabled ? [action] : [],
  ),
  comment: reviewOpen(change),
  resolve: reviewOpen(change),
  verdicts: reviewOpen(change)
    ? [
        "comment" as const,
        ...(review.permittedLabels["Code-Review"]?.includes(1) ? ["approve" as const] : []),
        ...(review.permittedLabels["Code-Review"]?.includes(-1)
          ? ["request-changes" as const]
          : []),
      ]
    : [],
  requestReviewers: reviewOpen(change),
  updateMethods: ["rebase" as const],
  labels: false,
  editChangeRequest: false,
});

/** The resolver maps the generic host to a configured HTTP base URL. */
export const make = Effect.fn("GerritPullRequestProvider.make")(function* (
  resolveCredential: GerritCredentialResolver,
) {
  const http = yield* GerritHttp;
  const direct = makeDirectActions(http.directWrite, http.getChangeByNumber);
  const auth = Effect.fn("GerritPullRequestProvider.auth")(function* (
    host: string | undefined,
    operation: string,
  ) {
    if (!host) return yield* error(operation, "A Gerrit host is required.");
    const resolved = yield* resolveCredential(host);
    return resolved;
  });
  const fail = (operation: string) => (cause: import("@t3tools/contracts").GerritReadError) =>
    new PullRequestProviderError({
      provider: kind,
      operation,
      reason:
        cause.reason === "authentication"
          ? "unauthenticated"
          : cause.reason === "rate-limit"
            ? "rate-limited"
            : cause.reason === "not-found-or-hidden"
              ? "not-found"
              : "failed",
      detail: `Gerrit read failed (${cause.reason}).`,
      cause,
    });
  const read = Effect.fn("GerritPullRequestProvider.read")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
    operation: string,
  ) {
    const a = yield* auth(input.host, operation);
    const number = yield* decodeNumber(input.number).pipe(
      Effect.mapError(() => error(operation, "Invalid change number.")),
    );
    const change = yield* http
      .getChangeByNumber({ ...a, number })
      .pipe(Effect.mapError(fail(operation)));
    if (change.key.project !== input.repository)
      return yield* error(operation, "Change belongs to a different Gerrit project.");
    return { a, change };
  });
  const review = Effect.fn("GerritPullRequestProvider.review")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
    operation: string,
  ) {
    const { a, change } = yield* read(input, operation);
    const detail = yield* http.review
      .readReview({
        ...a,
        key: change.key,
        number: change.number,
        revision: change.currentRevision,
      })
      .pipe(Effect.mapError(fail(operation)));
    return { a, change, detail };
  });
  const row = (server: string, change: GerritReadChange, updated: string) =>
    baseRow(server, { ...change, project: change.key.project, branch: change.key.branch }, updated);
  const identity = Effect.fn("GerritPullRequestProvider.identity")(function* (
    input: { readonly host?: string },
    operation: string,
  ) {
    const a = yield* auth(input.host, operation);
    const account = yield* http.readSelfAccount(a).pipe(Effect.mapError(fail(operation)));
    return {
      a,
      accountId: String(account._account_id),
      viewer: actor(account)?.login ?? String(account._account_id),
    };
  });
  const requireOpen = (change: Pick<GerritReadChange, "status">, operation: string) =>
    reviewOpen(change)
      ? Effect.void
      : Effect.fail(
          error(
            operation,
            `This Gerrit change is ${change.status === "MERGED" ? "merged" : "abandoned"}; its review is closed.`,
          ),
        );
  const writeFail = (operation: string) => (cause: unknown) =>
    new PullRequestProviderError({
      provider: kind,
      operation,
      reason: "failed",
      detail: "Gerrit write failed.",
      cause,
    });
  const thread = Effect.fn("GerritPullRequestProvider.thread")(function* (
    input: ProviderRepositoryRef & { readonly number: number; readonly threadId: string },
    operation: string,
  ) {
    const { a, change, detail } = yield* review(input, operation);
    const found = mapGerritActivity(detail).gerritThreads.find((t) => t.id === input.threadId);
    const comment = found?.comments.findLast((c) => c.visibility === "published");
    if (!comment) return yield* error(operation, "Published Gerrit thread not found.");
    return { a, change, comment };
  });
  const api: PullRequestProviderApi = {
    kind,
    gerrit: {
      setVotes: Effect.fn("GerritPullRequestProvider.setVotes")(function* (input) {
        const { a, change } = yield* read(input, "setVotes");
        yield* requireOpen(change, "setVotes");
        yield* direct
          .review(a, { number: input.number, project: input.repository }, { labels: input.votes })
          .pipe(Effect.mapError(writeFail("setVotes")));
      }),
      setTopic: Effect.fn("GerritPullRequestProvider.setTopic")(function* (input) {
        const a = yield* auth(input.host, "setTopic");
        yield* direct
          .setTopic(a, { number: input.number, project: input.repository }, input.topic)
          .pipe(Effect.mapError(writeFail("setTopic")));
      }),
      setPrivate: Effect.fn("GerritPullRequestProvider.setPrivate")(function* (input) {
        const a = yield* auth(input.host, "setPrivate");
        yield* direct
          .setPrivate(a, { number: input.number, project: input.repository }, input.isPrivate)
          .pipe(Effect.mapError(writeFail("setPrivate")));
      }),
      setCommitMessage: Effect.fn("GerritPullRequestProvider.setCommitMessage")(function* (input) {
        const a = yield* auth(input.host, "setCommitMessage");
        yield* direct
          .setCommitMessage(a, { number: input.number, project: input.repository }, input.message)
          .pipe(Effect.mapError(writeFail("setCommitMessage")));
      }),
      rebaseChain: Effect.fn("GerritPullRequestProvider.rebaseChain")(function* (input) {
        const a = yield* auth(input.host, "rebaseChain");
        yield* direct
          .rebaseChain(
            a,
            { number: input.number, project: input.repository },
            input.base === undefined ? {} : { base: input.base },
          )
          .pipe(Effect.mapError(writeFail("rebaseChain")));
      }),
      cherryPick: Effect.fn("GerritPullRequestProvider.cherryPick")(function* (input) {
        const a = yield* auth(input.host, "cherryPick");
        return yield* direct
          .cherryPick(
            a,
            { number: input.number, project: input.repository },
            {
              destination: input.destination,
              ...(input.message === undefined ? {} : { message: input.message }),
            },
          )
          .pipe(Effect.mapError(writeFail("cherryPick")));
      }),
    },
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge", "close", "reopen", "draft", "ready", "update-branch"],
      mergeMethods: [],
      search: true,
      reactions: false,
      review: {
        inlineComment: true,
        reply: true,
        resolve: true,
        resolveWithReply: true,
        verdicts: ["comment", "approve", "request-changes"],
      },
      reviewers: { request: true, listCandidates: true, searchCandidates: true },
      stacks: true,
      stackActions: false,
      labels: false,
      edit: { changeRequest: false, comment: false },
    },
    repositoryKey: ({ canonicalKey }) => canonicalKey,
    getViewer: (input) => identity(input, "getViewer").pipe(Effect.map((x) => x.viewer)),
    getRoutingIdentity: (input) =>
      identity(input, "getRoutingIdentity").pipe(
        Effect.map(({ accountId, viewer }) => ({ accountId, viewer })),
      ),
    withVerifiedCredential: (input, use) =>
      identity(input, "withVerifiedCredential").pipe(
        Effect.flatMap(({ a, accountId, viewer }) => {
          return use({ accountId, viewer, credentialFingerprint: a.credentialFingerprint });
        }),
      ),
    listChangeRequests: Effect.fn("GerritPullRequestProvider.listChangeRequests")(
      function* (input) {
        const a = yield* auth(input.host, "listChangeRequests");
        const page = yield* http
          .searchChanges({
            ...a,
            status: input.state === "closed" ? "abandoned" : input.state,
            project: input.repository,
            limit: input.limit,
            offset: input.cursor?.delivered ?? 0,
            ...(input.involvement === "authored" ? { owner: input.viewer } : {}),
            ...(input.query ? { search: input.query } : {}),
          })
          .pipe(Effect.mapError(fail("listChangeRequests")));
        return {
          items: page.changes.map((c) => baseRow(a.installation, c, c.updated)),
          cursorAdvance: page.changes.length,
          continues: page.completeness === "more",
          truncated: page.completeness === "truncated",
        };
      },
    ),
    getChangeRequest: Effect.fn("GerritPullRequestProvider.getChangeRequest")(function* (input) {
      const { a, change, detail } = yield* review(input, "getChangeRequest");
      const timestamp = change.updated ?? detail.updated ?? change.revisions[0].author.date;
      const files = yield* http.review
        .readFiles({
          ...a,
          key: change.key,
          number: change.number,
          revision: change.currentRevision,
          comparison: { kind: "base" },
        })
        .pipe(Effect.mapError(fail("getChangeRequest")));
      return {
        ...row(a.installation, change, timestamp),
        gerrit: {
          changeId: change.key.changeId,
          topic: detail.topic,
          isPrivate: change.isPrivate,
          isWip: change.workInProgress,
          permissions: gerritDetailPermissions(detail),
          currentPatchSet: change.currentPatchSet,
          patchSets: change.patchSetDetails.map((p) => ({
            number: p.number,
            commit: p.commit,
            createdAt: (p.created ?? change.created ?? timestamp)
              .replace(" ", "T")
              .replace(/(\d)$/, "$1Z"),
            ...(p.uploader === undefined ? {} : { uploader: p.uploader }),
          })),
          labels: Object.entries(detail.labels).map(([name, label]) => ({
            name,
            votes: (label.all ?? []).flatMap((account) =>
              account.value === undefined ? [] : [{ account, value: account.value }],
            ),
            permittedValues: reviewOpen(change) ? (detail.permittedLabels[name] ?? []) : [],
            ...(label.values === undefined ? {} : { valueDescriptions: label.values }),
            required: !label.optional,
          })),
          submitRequirements: (detail.requirements ?? []).map((r) => {
            const statuses = {
              SATISFIED: "satisfied",
              UNSATISFIED: "unsatisfied",
              NOT_APPLICABLE: "not-applicable",
              ERROR: "error",
              OVERRIDDEN: "override",
            } as const;
            const status = Object.hasOwn(statuses, r.status)
              ? statuses[r.status as keyof typeof statuses]
              : "unknown";
            return {
              name: r.name,
              status,
              ...(r.description === undefined ? {} : { description: r.description }),
            };
          }),
          submittable: detail.submittable,
        },
        headSha: change.currentRevision,
        body: detail.commitMessage ?? "",
        // Gerrit lists magic files such as /COMMIT_MSG beside the real ones.
        changedFiles: files.filter((f) => !f.path.startsWith("/")).length,
        mergedAt: null,
        closedAt: null,
        reviewers: Object.values(detail.reviewers).flatMap((accounts) =>
          accounts.flatMap((a) => actor(a) ?? []),
        ),
        checks: detail.checks.kind === "available" ? mapChecks(detail.checks.values) : [],
        mergeCapabilities: { merge: false, squash: false, rebase: false },
        viewerPermissions: permissions(detail, change),
      };
    }),
    getChangeRequestSummary: Effect.fn("GerritPullRequestProvider.getChangeRequestSummary")(
      function* (input) {
        const { a, change } = yield* read(input, "getChangeRequestSummary");
        return row(a.installation, change, change.updated ?? change.revisions[0].author.date);
      },
    ),
    getChangeRequestPreview: Effect.fn("GerritPullRequestProvider.getChangeRequestPreview")(
      function* (input) {
        const { a, change } = yield* read(input, "getChangeRequestPreview");
        return row(a.installation, change, change.updated ?? change.revisions[0].author.date);
      },
    ),
    getViewerPermissions: Effect.fn("GerritPullRequestProvider.getViewerPermissions")(
      function* (input) {
        const { change, detail } = yield* review(input, "getViewerPermissions");
        return permissions(detail, change);
      },
    ),
    getChangeRequestChecks: Effect.fn("GerritPullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        const { change, detail } = yield* review(input, "getChangeRequestChecks");
        if (detail.checks.kind !== "available")
          return yield* error(
            "getChangeRequestChecks",
            "Gerrit checks are unavailable or not configured.",
          );
        return {
          state: state(change.status),
          checks: mapChecks(detail.checks.values),
        };
      },
    ),
    getChangeRequestWatchFingerprint: Effect.fn(
      "GerritPullRequestProvider.getChangeRequestWatchFingerprint",
    )(function* (input) {
      const { a, change } = yield* read(input, "getChangeRequestWatchFingerprint");
      const result = yield* http
        .readWatchChanges({ ...a, numbers: [change.number] })
        .pipe(Effect.mapError(fail("getChangeRequestWatchFingerprint")));
      const found = result.changes[0];
      if (!found || found.project !== input.repository)
        return yield* error(
          "getChangeRequestWatchFingerprint",
          "Change is unavailable or belongs to a different project.",
        );
      const status = yield* encodeFingerprint([
        found.status,
        found.currentRevision,
        found.updated,
        found.mergeable,
        found.requirements,
      ]).pipe(
        Effect.mapError(() =>
          error("getChangeRequestWatchFingerprint", "Cannot encode Gerrit status."),
        ),
      );
      const remarks = yield* encodeFingerprint([
        found.labels,
        found.messages,
        found.totalCommentCount,
        found.unresolvedCommentCount,
      ]).pipe(
        Effect.mapError(() =>
          error("getChangeRequestWatchFingerprint", "Cannot encode Gerrit remarks."),
        ),
      );
      return { status, remarks };
    }),
    getChangeRequestStack: Effect.fn("GerritPullRequestProvider.getChangeRequestStack")(
      function* (input) {
        const { a, change } = yield* read(input, "getChangeRequestStack");
        const related = yield* http
          .getRelatedChanges({
            ...a,
            key: change.key,
            number: change.number,
            revision: change.currentRevision,
          })
          .pipe(Effect.mapError(fail("getChangeRequestStack")));
        if (
          related.completeness !== "complete-visible" ||
          related.revisions.some(
            (r) =>
              r.number === undefined || r.status === undefined || r.project !== input.repository,
          )
        )
          return null;
        const revisions = related.revisions;
        if (revisions.length === 0) {
          return {
            id: `${a.installation}${input.repository}:${change.number}`,
            number: change.number,
            url: url(a.installation, input.repository, change.number),
            base: change.key.branch,
            layers: [
              {
                number: change.number,
                title: change.subject,
                headBranch: changeRef(change.number, change.currentPatchSet),
                headSha: change.currentRevision,
                state: state(change.status),
                isDraft: change.workInProgress,
              },
            ],
          };
        }
        if (
          !revisions.some((r) => r.commit === change.currentRevision) ||
          new Set(revisions.map((r) => r.number)).size !== revisions.length
        )
          return null;
        const ordered = revisions.toReversed();
        if (ordered.some((r, i) => i > 0 && !r.parents.includes(ordered[i - 1]!.commit)))
          return null;
        return {
          id: `${a.installation}${input.repository}:${change.number}`,
          number: change.number,
          url: url(a.installation, input.repository, change.number),
          base: change.key.branch,
          layers: ordered.flatMap((r) =>
            r.number === undefined || r.status === undefined
              ? []
              : [
                  {
                    number: r.number,
                    title: r.subject,
                    headBranch: changeRef(r.number, r.patchSet),
                    headSha: r.commit,
                    state: state(r.status),
                    isDraft: r.workInProgress ?? false,
                  },
                ],
          ),
        };
      },
    ),
    getDiff: Effect.fn("GerritPullRequestProvider.getDiff")(function* (input) {
      if (input.cursor) return yield* error("getDiff", "Diff cursors are not supported.");
      const { a, change } = yield* read(input, "getDiff");
      const revision = change.revisions.find(
        (r) => r.commit === (input.commit ?? change.currentRevision),
      )?.commit;
      if (!revision) return yield* error("getDiff", "Unknown patch set.");
      const args = {
        ...a,
        key: change.key,
        number: change.number,
        revision,
        comparison: { kind: "base" as const },
      };
      const files = yield* http.review.readFiles(args).pipe(Effect.mapError(fail("getDiff")));
      const diffs = yield* Effect.forEach(
        files.filter((f) => f.path !== "/COMMIT_MSG"),
        (f) =>
          http.review.readDiff({ ...args, path: f.path }).pipe(
            Effect.map((diff) => ({ ...f, diff })),
            Effect.mapError(fail("getDiff")),
          ),
        { concurrency: 4 },
      );
      return { ...renderGerritUnifiedDiff(diffs), nextCursor: null };
    }),
    getChangeRequestActivity: Effect.fn("GerritPullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const { change, detail } = yield* review(input, "getChangeRequestActivity");
        return mapGerritActivity({
          ...detail,
          patchSets: change.patchSetDetails.map((patchSet) => ({
            ...patchSet,
            fallbackDate:
              change.revisions.find((revision) => revision.commit === patchSet.commit)?.committer
                .date ?? change.created,
          })),
        });
      },
    ),
    // Gerrit only suggests accounts for a search, so the unsearched list is the current reviewers
    // and is marked truncated; typing asks Gerrit's suggest_reviewers.
    listReviewerCandidates: Effect.fn("GerritPullRequestProvider.listReviewerCandidates")(
      function* (input) {
        const { a, change, detail } = yield* review(input, "listReviewerCandidates");
        const current = Object.values(detail.reviewers).flat();
        const requested = new Set(current.map((account) => account._account_id));
        const query = input.query?.trim();
        const accounts = query
          ? yield* http.review
              .suggestReviewers({
                ...a,
                key: change.key,
                number: change.number,
                revision: change.currentRevision,
                query,
                state: "REVIEWER",
              })
              .pipe(Effect.mapError(fail("listReviewerCandidates")))
          : current;
        return {
          candidates: accounts.flatMap((account) => {
            const person = actor(account);
            return person === null || account._account_id === undefined
              ? []
              : [
                  {
                    ...person,
                    id: String(account._account_id),
                    kind: "user" as const,
                    isRequested: requested.has(account._account_id),
                  },
                ];
          }),
          truncated: query === undefined || query.length === 0,
        };
      },
    ),
    comment: Effect.fn("GerritPullRequestProvider.comment")(function* (input) {
      const { a, change } = yield* read(input, "comment");
      yield* requireOpen(change, "comment");
      yield* direct
        .review(
          a,
          { number: change.number, revision: change.currentRevision },
          { message: input.body },
        )
        .pipe(Effect.mapError(writeFail("comment")));
    }),
    submitReview: Effect.fn("GerritPullRequestProvider.submitReview")(function* (input) {
      const { a, change, detail } = yield* review(input, "submitReview");
      yield* requireOpen(change, "submitReview");
      const value =
        input.verdict === "approve" ? 1 : input.verdict === "request-changes" ? -1 : undefined;
      if (value !== undefined && !detail.permittedLabels["Code-Review"]?.includes(value))
        return yield* error("submitReview", "The requested Code-Review vote is not permitted.");
      const comments = input.comments.map((c) => {
        const p = c.position;
        const left = p.kind === "deleted" || (p.kind === "context" && p.side === "left");
        return {
          path: c.path,
          message: c.body,
          side: left ? ("PARENT" as const) : ("REVISION" as const),
          line:
            p.kind === "added"
              ? p.newLine
              : p.kind === "deleted"
                ? p.oldLine
                : left
                  ? p.oldLine
                  : p.newLine,
        };
      });
      yield* direct
        .review(
          a,
          { number: change.number, revision: change.currentRevision },
          {
            message: input.body,
            comments,
            ...(value === undefined ? {} : { labels: { "Code-Review": value } }),
          },
        )
        .pipe(Effect.mapError(writeFail("submitReview")));
    }),
    replyToThread: Effect.fn("GerritPullRequestProvider.replyToThread")(function* (input) {
      const { a, change, comment } = yield* thread(input, "replyToThread");
      yield* requireOpen(change, "replyToThread");
      yield* direct
        .reply(
          a,
          {
            number: change.number,
            revision: comment.revision ?? comment.patchSet ?? change.currentRevision,
          },
          {
            comment: {
              ...comment.anchor,
              inReplyTo: comment.id,
              message: input.body,
              ...(input.resolve
                ? { unresolved: false }
                : comment.unresolved === null
                  ? {}
                  : { unresolved: comment.unresolved }),
            },
          },
        )
        .pipe(Effect.mapError(writeFail("replyToThread")));
    }),
    setThreadResolution: Effect.fn("GerritPullRequestProvider.setThreadResolution")(
      function* (input) {
        const { a, change, comment } = yield* thread(input, "setThreadResolution");
        yield* requireOpen(change, "setThreadResolution");
        yield* direct
          .reply(
            a,
            {
              number: change.number,
              revision: comment.revision ?? comment.patchSet ?? change.currentRevision,
            },
            {
              comment: {
                ...comment.anchor,
                inReplyTo: comment.id,
                message: input.resolved ? "Done" : "Reopened",
                unresolved: !input.resolved,
              },
            },
          )
          .pipe(Effect.mapError(writeFail("setThreadResolution")));
      },
    ),
    setReviewerRequest: Effect.fn("GerritPullRequestProvider.setReviewerRequest")(
      function* (input) {
        if (input.reviewers.some((r) => r.kind !== "user"))
          return yield* error("setReviewerRequest", "Gerrit team reviewers are not supported.");
        const { a, change } = yield* read(input, "setReviewerRequest");
        yield* requireOpen(change, "setReviewerRequest");
        let completed = 0;
        for (const reviewer of input.reviewers) {
          const action = input.requested
            ? direct.addReviewer(
                a,
                { number: change.number },
                { reviewer: reviewer.id, state: "REVIEWER" },
              )
            : direct.removeReviewer(a, { number: change.number }, { reviewer: reviewer.id });
          yield* action.pipe(
            Effect.mapError((cause) =>
              error(
                "setReviewerRequest",
                `Reviewer update failed after ${completed} of ${input.reviewers.length} succeeded: ${String(cause)}`,
              ),
            ),
          );
          completed++;
        }
      },
    ),
    runAction: Effect.fn("GerritPullRequestProvider.runAction")(function* (input) {
      if (!["merge", "close", "reopen", "draft", "ready", "update-branch"].includes(input.action))
        return yield* error("runAction", "Unsupported Gerrit action.");
      if (input.mergeMethod || (input.updateMethod && input.updateMethod !== "rebase"))
        return yield* error("runAction", "Gerrit does not support the requested method.");
      const { a, change, detail } = yield* review(input, "runAction");
      if (!permissions(detail, change).actions.some((a) => a === input.action))
        return yield* error("runAction", "Gerrit action is not permitted.");
      const target = { number: change.number };
      const action =
        input.action === "merge"
          ? direct.submit(a, target)
          : input.action === "close"
            ? direct.abandon(a, target)
            : input.action === "reopen"
              ? direct.restore(a, target)
              : input.action === "draft"
                ? direct.setWip(a, target, true)
                : input.action === "ready"
                  ? direct.setWip(a, target, false)
                  : direct.rebase(a, target);
      yield* action.pipe(Effect.mapError(writeFail("runAction")));
    }),
    setReaction: () => unsupported("setReaction"),
  };
  return api;
});
