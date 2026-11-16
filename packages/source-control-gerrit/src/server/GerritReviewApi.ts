import {
  GerritAccount,
  GerritCheck,
  GerritActionInfo,
  GerritChangeId,
  GerritChangeKey,
  GerritChangeMessage,
  GerritChangeNumber,
  GerritComment,
  GerritCommentAnchor,
  GerritCommentRange,
  GerritDiffContent,
  GerritDiffInput,
  GerritDiffResult,
  GerritFile,
  GerritFilesInput,
  GerritInstallationId,
  GerritLabel,
  GerritPatchSetNumber,
  GerritReadChange,
  GerritReadError,
  GerritRequirement,
  GerritReviewDetail,
  GerritReviewInput,
  GerritReviewerSearchInput,
  GitCommitOid,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { GerritHttpCredentials } from "./GerritHttp.ts";

type Auth = {
  readonly installation: GerritInstallationId;
  readonly credentials: GerritHttpCredentials;
  readonly checksProfile?: "checks-rest-v1-3.10";
};
type Request = <S extends Schema.Top & { readonly DecodingServices: never }>(
  auth: Auth,
  path: string,
  schema: S,
  parameters?: ReadonlyArray<readonly [string, string]>,
  write?: { readonly method: "POST" | "PUT" | "DELETE"; readonly body: unknown },
) => Effect.Effect<S["Type"], GerritReadError>;
const OptionalText = Schema.optionalKey(Schema.String);
const WireComment = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()),
  patch_set: Schema.optionalKey(GerritPatchSetNumber),
  path: OptionalText,
  side: Schema.optionalKey(GerritCommentAnchor.fields.side),
  parent: Schema.optionalKey(Schema.Int),
  line: Schema.optionalKey(Schema.Int),
  range: Schema.optionalKey(GerritCommentRange),
  message: OptionalText,
  author: Schema.optionalKey(GerritAccount),
  updated: Schema.String,
  in_reply_to: OptionalText,
  change_message_id: OptionalText,
  unresolved: Schema.optionalKey(Schema.Boolean),
  commit_id: Schema.optionalKey(GitCommitOid),
});
const Comments = Schema.Record(Schema.String, Schema.Array(WireComment));
const SubmitRecordLabel = Schema.Struct({
  label: Schema.String,
  status: Schema.String,
  applied_by: Schema.optionalKey(GerritAccount),
});
const SubmitRecord = Schema.Struct({
  rule_name: Schema.String,
  status: Schema.String,
  labels: Schema.Array(SubmitRecordLabel),
});
const Detail = Schema.Struct({
  project: GerritChangeKey.fields.project,
  branch: GerritChangeKey.fields.branch,
  change_id: GerritChangeId,
  _number: GerritChangeNumber,
  current_revision: GitCommitOid,
  topic: OptionalText,
  updated: OptionalText,
  meta_rev_id: Schema.optionalKey(GitCommitOid),
  reviewers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(GerritAccount))),
  removable_reviewers: Schema.optionalKey(Schema.Array(GerritAccount)),
  labels: Schema.optionalKey(Schema.Record(Schema.String, GerritLabel)),
  permitted_labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  actions: Schema.optionalKey(Schema.Record(Schema.String, GerritActionInfo)),
  submit_requirements: Schema.optionalKey(Schema.Array(GerritRequirement)),
  submit_records: Schema.optionalKey(Schema.Array(SubmitRecord)),
  mergeable: Schema.optionalKey(Schema.Boolean),
  submittable: Schema.optionalKey(Schema.Boolean),
  messages: Schema.optionalKey(Schema.Array(GerritChangeMessage)),
  revisions: Schema.Record(
    GitCommitOid,
    Schema.Struct({
      actions: Schema.optionalKey(Schema.Record(Schema.String, GerritActionInfo)),
      commit: Schema.Struct({ message: OptionalText }),
    }),
  ),
});
const FileInfo = Schema.Struct({
  status: OptionalText,
  old_path: OptionalText,
  binary: Schema.optionalKey(Schema.Boolean),
  lines_inserted: Schema.optionalKey(Schema.Int),
  lines_deleted: Schema.optionalKey(Schema.Int),
  size: Schema.optionalKey(Schema.Number),
});
const Diff = Schema.Struct({
  meta_a: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
  meta_b: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
  diff_header: Schema.Array(Schema.String),
  content: Schema.Array(GerritDiffContent),
  binary: Schema.optionalKey(Schema.Boolean),
});
const Mergeability = Schema.Struct({
  mergeable: Schema.Boolean,
  strategy: OptionalText,
  submit_type: OptionalText,
});
const invalid = () => new GerritReadError({ reason: "invalid-response" });
const decodeComment = Schema.decodeEffect(GerritComment);
const decodeReviewInput = Schema.decodeEffect(GerritReviewInput);
const decodeReviewerSearchInput = Schema.decodeEffect(GerritReviewerSearchInput);
const decodeFilesInput = Schema.decodeEffect(GerritFilesInput);
const decodeDiffInput = Schema.decodeEffect(GerritDiffInput);
const privateFailure = (error: GerritReadError) =>
  error.reason === "authentication" || error.reason === "forbidden";
const encode = encodeURIComponent;
const prefix = (input: GerritReviewInput) => `changes/${input.number}/revisions/${input.revision}`;
const detailOptions = [
  "ALL_REVISIONS",
  "ALL_COMMITS",
  "DETAILED_ACCOUNTS",
  "DETAILED_LABELS",
  "CURRENT_ACTIONS",
  "CHANGE_ACTIONS",
  "SUBMIT_REQUIREMENTS",
  "SUBMITTABLE",
  "MESSAGES",
];

/**
 * Gerrit's legacy submit record has five label states. `MAY` means the label is optional, so a
 * missing vote there must not read as a blocker; `NEED`, `REJECT` and `IMPOSSIBLE` do block.
 * Records can repeat a label, and a blocking answer wins over an optional one.
 */
const legacyRequirements = (
  records: ReadonlyArray<{
    readonly labels: ReadonlyArray<{
      readonly label: string;
      readonly status: string;
      readonly applied_by?: typeof GerritAccount.Type;
    }>;
  }>,
): Array<typeof GerritRequirement.Type> => {
  const byLabel = new Map<string, typeof GerritRequirement.Type>();
  for (const label of records.flatMap((record) => record.labels)) {
    const satisfied =
      label.applied_by !== undefined || label.status === "OK" || label.status === "MAY";
    const next = {
      name: label.label,
      status: satisfied ? "SATISFIED" : "UNSATISFIED",
      description:
        label.applied_by !== undefined || label.status === "OK"
          ? `Legacy submit rule: ${label.label} vote is satisfied.`
          : label.status === "MAY"
            ? `Legacy submit rule: ${label.label} is optional and has no vote.`
            : `Legacy submit rule: ${label.label} is blocking; its required vote is missing or rejected (${label.status}).`,
      source: "legacy-submit-rule" as const,
    };
    const previous = byLabel.get(label.label);
    if (
      previous === undefined ||
      (previous.status === "SATISFIED" && next.status === "UNSATISFIED")
    )
      byLabel.set(label.label, next);
  }
  return [...byLabel.values()];
};

export const makeReviewApi = (
  request: Request,
  getChange: (
    input: Auth & {
      readonly key: GerritChangeKey;
      readonly number: typeof GerritChangeNumber.Type;
    },
  ) => Effect.Effect<GerritReadChange, GerritReadError>,
) => {
  const validate = Effect.fn("GerritHttp.validateReview")(function* (
    input: Auth & GerritReviewInput,
  ) {
    const change = yield* getChange(input);
    if (
      input.installation !== input.key.installation ||
      !change.revisions.some((r) => r.commit === input.revision)
    )
      return yield* new GerritReadError({ reason: "identity-mismatch" });
    return change;
  });
  const normalizeComments = Effect.fn("GerritHttp.normalizeComments")(function* (
    wire: typeof Comments.Type,
    change: GerritReadChange,
    visibility: GerritComment["visibility"],
  ) {
    return yield* Effect.forEach(
      Object.entries(wire).flatMap(([path, comments]) => comments.map((c) => ({ path, c }))),
      ({ path, c }) => {
        const revisions = change.revisions.filter((r) => r.patchSet === c.patch_set);
        const revision = revisions.length === 1 ? revisions[0] : undefined;
        const side = c.side ?? "REVISION";
        let identity: NonNullable<GerritComment["identity"]> = revision
          ? { kind: "known" }
          : { kind: "unknown", reason: "Owning patch set is missing or ambiguous" };
        if (revision) {
          const expected =
            side === "REVISION" ? revision.commit : revision.parents[(c.parent ?? 1) - 1];
          if (
            (c.parent !== undefined &&
              (side !== "PARENT" || c.parent < 1 || c.parent > revision.parents.length)) ||
            (side === "PARENT" && revision.parents.length === 0) ||
            (c.commit_id !== undefined &&
              (side === "REVISION" || c.parent !== undefined || revision.parents.length === 1) &&
              c.commit_id !== expected)
          )
            identity = {
              kind: "contradictory",
              reason: "Native content commit or parent contradicts the owning patch set",
            };
        }
        return decodeComment({
          id: c.id,
          patchSet: c.patch_set ?? null,
          revision: revision?.commit ?? null,
          contentCommit: c.commit_id ?? null,
          ...(c.parent === undefined ? {} : { nativeParent: c.parent }),
          identity,
          anchor: {
            path: path === "/PATCHSET_LEVEL" ? null : (c.path ?? path),
            side,
            ...(c.parent === undefined || c.parent < 1 ? {} : { parent: c.parent }),
            ...(c.line === undefined ? {} : { line: c.line }),
            ...(c.range === undefined ? {} : { range: c.range }),
          },
          message: c.message ?? null,
          author: c.author ?? null,
          updated: c.updated,
          inReplyTo: c.in_reply_to ?? null,
          ...(c.change_message_id === undefined ? {} : { changeMessageId: c.change_message_id }),
          unresolved: c.unresolved ?? null,
          visibility,
        }).pipe(Effect.mapError(invalid));
      },
    );
  });
  const suggestReviewers = Effect.fn("GerritHttp.suggestReviewers")(function* (
    raw: Auth & typeof GerritReviewerSearchInput.Type,
  ) {
    const input = yield* decodeReviewerSearchInput(raw).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    if (!input.query.trim()) return yield* new GerritReadError({ reason: "invalid-input" });
    const auth = { ...raw, ...input };
    yield* validate(auth);
    const rows = yield* request(
      auth,
      `changes/${input.number}/suggest_reviewers`,
      Schema.Array(Schema.Struct({ account: Schema.optionalKey(GerritAccount) })),
      [
        ["q", input.query.trim()],
        ["n", "20"],
        ["exclude-groups", "true"],
        ["reviewer-state", input.state],
      ],
    );
    return rows
      .flatMap(({ account }) =>
        account?._account_id === undefined
          ? []
          : [{ ...account, _account_id: account._account_id }],
      )
      .slice(0, 20);
  });
  const readReview = Effect.fn("GerritHttp.readReview")(function* (raw: Auth & GerritReviewInput) {
    const input = yield* decodeReviewInput(raw).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    const auth = { ...raw, ...input };
    const change = yield* validate(auth);
    const wire = yield* request(
      auth,
      `changes/${input.number}/detail`,
      Detail,
      detailOptions.map((o) => ["o", o]),
    );
    if (
      wire.project !== input.key.project ||
      wire.branch !== input.key.branch ||
      wire.change_id !== input.key.changeId ||
      wire._number !== input.number ||
      wire.current_revision !== change.currentRevision ||
      wire.revisions[input.revision] === undefined
    )
      return yield* new GerritReadError({ reason: "identity-mismatch" });
    // The change detail mergeable field may be omitted even when Gerrit supports the
    // revision-specific endpoint. Keep its failure independent from the review read.
    const mergeability = yield* request(auth, `${prefix(input)}/mergeable`, Mergeability).pipe(
      Effect.result,
    );
    const revisionActions = yield* request(
      auth,
      `${prefix(input)}/actions`,
      Schema.Record(Schema.String, GerritActionInfo),
    );
    const published = yield* request(auth, `changes/${input.number}/comments`, Comments);
    const draftsWire = yield* request(auth, `changes/${input.number}/drafts`, Comments);
    const comments = yield* normalizeComments(published, change, "published");
    const drafts = yield* normalizeComments(draftsWire, change, "server-draft");
    const ported = yield* request(auth, `${prefix(input)}/ported_comments`, Comments).pipe(
      Effect.result,
    );
    if (Result.isFailure(ported) && privateFailure(ported.failure)) return yield* ported.failure;
    const permittedLabels: Record<string, number[]> = {};
    for (const [name, values] of Object.entries(wire.permitted_labels ?? {})) {
      if (values.some((v) => !/^[ +-]?\d+$/.test(v) || !Number.isSafeInteger(Number(v))))
        return yield* invalid();
      permittedLabels[name] = values.map(Number);
    }
    const portedComments = Result.isSuccess(ported)
      ? yield* normalizeComments(ported.success, change, "published")
      : [];
    let checks: GerritReviewDetail["checks"] = { kind: "not-configured" };
    if (auth.checksProfile === "checks-rest-v1-3.10") {
      const version = yield* request(auth, "config/server/version", Schema.String).pipe(
        Effect.result,
      );
      if (Result.isFailure(version) && privateFailure(version.failure))
        return yield* version.failure;
      if (Result.isSuccess(version) && /^3\.10\.\d+$/.test(version.success)) {
        const result = yield* request(
          auth,
          `${prefix(input)}/checks~checks`,
          Schema.Array(GerritCheck).check(Schema.isMaxLength(1000)),
          [["o", "CHECKER"]],
        ).pipe(Effect.result);
        if (Result.isFailure(result) && privateFailure(result.failure))
          return yield* result.failure;
        if (Result.isSuccess(result)) {
          const patchSet = change.revisions.find(
            (revision) => revision.commit === input.revision,
          )?.patchSet;
          if (
            result.success.some(
              (check) =>
                check.repository !== input.key.project ||
                check.change_number !== input.number ||
                check.patch_set_id !== patchSet,
            ) ||
            new Set(result.success.map((check) => check.checker_uuid)).size !==
              result.success.length
          )
            return yield* invalid();
          checks = { kind: "available", profile: "checks-rest-v1-3.10", values: result.success };
        } else
          checks = {
            kind: "unavailable",
            reason:
              "Configured checks plugin is absent, unavailable, or does not match the supported wire profile.",
          };
      } else
        checks = {
          kind: "unavailable",
          reason:
            "The legacy checks profile requires an observed Gerrit 3.10.x version; other deployments are unverified.",
        };
    }
    const messageAccountIds = [
      ...new Set(
        (wire.messages ?? []).flatMap((message) =>
          Array.from(message.message.matchAll(/<GERRIT_ACCOUNT_(\d+)>/g), (match) => match[1]!),
        ),
      ),
    ]
      .filter((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)
      .slice(0, 32);
    const resolvedAccounts = yield* Effect.forEach(
      messageAccountIds,
      (id) =>
        request(auth, `accounts/${id}`, GerritAccount).pipe(
          Effect.result,
          Effect.map((result) => ({ id, result })),
        ),
      { concurrency: 4 },
    );
    const messageAccounts = Object.fromEntries(
      resolvedAccounts.flatMap(({ id, result }) =>
        Result.isSuccess(result) && result.success._account_id === Number(id)
          ? [[id, result.success]]
          : [],
      ),
    );
    return {
      change,
      commitMessage: wire.revisions[input.revision]?.commit.message ?? null,
      topic: wire.topic ?? null,
      updated: wire.updated ?? null,
      metaRevision: wire.meta_rev_id ?? null,
      reviewers: wire.reviewers ?? {},
      removableReviewers: wire.removable_reviewers ?? [],
      labels: wire.labels ?? {},
      permittedLabels,
      actions: wire.actions ?? {},
      revisionActions,
      requirements:
        wire.submit_requirements && wire.submit_requirements.length > 0
          ? wire.submit_requirements
          : wire.submit_records === undefined
            ? (wire.submit_requirements ?? null)
            : legacyRequirements(wire.submit_records),
      mergeable: Result.isSuccess(mergeability) ? mergeability.success.mergeable : null,
      submittable: wire.submittable ?? null,
      messages: wire.messages ?? [],
      messageAccounts,
      comments,
      drafts,
      portedComments: portedComments.map((c) => ({
        id: c.id,
        original: comments.find((o) => o.id === c.id && o.patchSet === c.patchSet) ?? null,
        displayAnchor: c.anchor,
        displayRevision: input.revision,
      })),
      porting: Result.isSuccess(ported) ? "available" : "unavailable",
      checks,
      observedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies GerritReviewDetail;
  });
  const comparisonParameters = Effect.fn("GerritHttp.comparison")(function* (
    input: Auth & typeof GerritFilesInput.Type,
  ) {
    const change = yield* validate(input);
    const selected = change.revisions.find((r) => r.commit === input.revision);
    switch (input.comparison.kind) {
      case "base":
        return [];
      case "parent":
        if (selected === undefined || input.comparison.parent > selected.parents.length)
          return yield* new GerritReadError({ reason: "invalid-input" });
        return [["parent", String(input.comparison.parent)]] as const;
      case "revision": {
        const comparison = input.comparison;
        const base = change.revisions.find((r) => r.commit === comparison.revision);
        if (base === undefined) return yield* new GerritReadError({ reason: "identity-mismatch" });
        return [["base", String(base.patchSet)]] as const;
      }
    }
  });
  const readFiles = Effect.fn("GerritHttp.readFiles")(function* (
    raw: Auth & typeof GerritFilesInput.Type,
  ) {
    const input = {
      ...raw,
      ...(yield* decodeFilesInput(raw).pipe(
        Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
      )),
    };
    const parameters = yield* comparisonParameters(input);
    const files = yield* request(
      input,
      `${prefix(input)}/files/`,
      Schema.Record(Schema.String, FileInfo),
      parameters,
    );
    return Object.entries(files).map(
      ([path, f]) =>
        ({
          path,
          status: f.status ?? "M",
          oldPath: f.old_path ?? null,
          binary: f.binary ?? false,
          inserted: f.lines_inserted ?? 0,
          deleted: f.lines_deleted ?? 0,
          size: f.size ?? null,
        }) satisfies typeof GerritFile.Type,
    );
  });
  const readDiff = Effect.fn("GerritHttp.readDiff")(function* (
    raw: Auth & typeof GerritDiffInput.Type,
  ): Effect.fn.Return<GerritDiffResult, GerritReadError> {
    const input = {
      ...raw,
      ...(yield* decodeDiffInput(raw).pipe(
        Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
      )),
    };
    const parameters = yield* comparisonParameters(input);
    const result = yield* request(
      input,
      `${prefix(input)}/files/${encode(input.path)}/diff`,
      Diff,
      [...parameters, ["context", "ALL"]],
    ).pipe(Effect.result);
    if (Result.isFailure(result)) {
      if (result.failure.reason === "oversize")
        return { kind: "oversize", reason: "The bounded diff response exceeded the size limit." };
      if (result.failure.reason === "not-found-or-hidden")
        return {
          kind: "unavailable-history",
          reason: "The requested historical file is unavailable or hidden.",
        };
      return yield* result.failure;
    }
    const diff = result.success;
    if (diff.binary) return { kind: "binary", reason: "Binary content has no text diff." };
    if (diff.diff_header.some((l) => /(?:^| )160000(?: |$)/.test(l)))
      return { kind: "submodule", reason: "Submodule revision change." };
    return {
      kind: "text",
      header: diff.diff_header,
      content: diff.content,
      oldPath: diff.meta_a?.name ?? null,
      newPath: diff.meta_b?.name ?? null,
    };
  });
  return {
    readReview,
    suggestReviewers,
    readFiles,
    readDiff,
  };
};
