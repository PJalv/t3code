import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import { GitCommitOid } from "./gerrit.ts";

const NonEmpty = Schema.String.check(Schema.isNonEmpty());
// Decode with `gerritDirectDecodeOptions` so unknown fields are rejected. A target with both
// `number` and `url` then matches neither branch.
export const gerritDirectDecodeOptions = { onExcessProperty: "error" } as const;
const strictStruct = Schema.Struct;
export const GerritDirectNotify = Schema.Literals(["NONE", "OWNER", "OWNER_REVIEWERS", "ALL"]);

export const GerritDirectTarget = Schema.Union([
  strictStruct({ number: PositiveInt }),
  strictStruct({ url: NonEmpty }),
]);
export type GerritDirectTarget = typeof GerritDirectTarget.Type;

export const GerritDirectComment = strictStruct({
  path: NonEmpty,
  line: Schema.optionalKey(PositiveInt),
  side: Schema.optionalKey(Schema.Literals(["REVISION", "PARENT"])),
  range: Schema.optionalKey(
    strictStruct({
      startLine: PositiveInt,
      startCharacter: NonNegativeInt,
      endLine: PositiveInt,
      endCharacter: NonNegativeInt,
    }),
  ),
  message: NonEmpty,
  inReplyTo: Schema.optionalKey(NonEmpty),
  unresolved: Schema.optionalKey(Schema.Boolean),
});
export type GerritDirectComment = typeof GerritDirectComment.Type;

export const GerritDirectAction = Schema.Union([
  strictStruct({
    kind: Schema.Literal("review"),
    message: Schema.optionalKey(Schema.String),
    labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
    comments: Schema.optionalKey(Schema.Array(GerritDirectComment)),
    publishDrafts: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  strictStruct({
    kind: Schema.Literal("reply"),
    commentId: NonEmpty,
    message: NonEmpty,
    unresolved: Schema.optionalKey(Schema.Boolean),
  }),
  strictStruct({
    kind: Schema.Literal("resolve"),
    commentId: NonEmpty,
    message: Schema.optionalKey(Schema.String),
  }),
  strictStruct({
    kind: Schema.Literal("draft"),
    comment: GerritDirectComment,
    id: Schema.optionalKey(Schema.String),
  }),
  strictStruct({ kind: Schema.Literal("delete-draft"), id: NonEmpty }),
  strictStruct({ kind: Schema.Literal("topic"), topic: Schema.NullOr(Schema.String) }),
  strictStruct({
    kind: Schema.Literal("add-reviewer"),
    account: NonEmpty,
    state: Schema.optionalKey(Schema.Literals(["REVIEWER", "CC"])),
  }),
  strictStruct({ kind: Schema.Literal("remove-reviewer"), account: NonEmpty }),
  strictStruct({ kind: Schema.Literal("wip"), value: Schema.Boolean }),
  strictStruct({
    kind: Schema.Literal("private"),
    value: Schema.Boolean,
    message: Schema.optionalKey(Schema.String),
  }),
  strictStruct({ kind: Schema.Literal("commit-message"), message: NonEmpty }),
  strictStruct({
    kind: Schema.Literals(["abandon", "restore"]),
    message: Schema.optionalKey(Schema.String),
  }),
  strictStruct({ kind: Schema.Literal("submit") }),
  strictStruct({
    kind: Schema.Literals(["rebase", "rebase-chain"]),
    base: Schema.optionalKey(Schema.String),
  }),
  strictStruct({
    kind: Schema.Literal("cherry-pick"),
    destination: NonEmpty,
    message: Schema.optionalKey(Schema.String),
    topic: Schema.optionalKey(Schema.String),
  }),
]);
export type GerritDirectAction = typeof GerritDirectAction.Type;

export const GerritDirectRead = Schema.Union([
  strictStruct({
    mode: Schema.Literal("change"),
    target: GerritDirectTarget,
    revision: Schema.optionalKey(NonEmpty),
    includeDrafts: Schema.optionalKey(Schema.Boolean),
  }),
  strictStruct({
    mode: Schema.Literal("comments"),
    target: GerritDirectTarget,
    revision: Schema.optionalKey(NonEmpty),
    includeDrafts: Schema.optionalKey(Schema.Boolean),
    cursor: Schema.optionalKey(NonEmpty),
    limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  }),
  strictStruct({
    mode: Schema.Literal("diff"),
    target: GerritDirectTarget,
    path: NonEmpty,
    revision: Schema.optionalKey(NonEmpty),
    base: Schema.optionalKey(NonEmpty),
  }),
  strictStruct({
    mode: Schema.Literal("reviewers"),
    target: GerritDirectTarget,
    query: NonEmpty,
    limit: Schema.optionalKey(PositiveInt),
  }),
  strictStruct({
    mode: Schema.Literal("search"),
    query: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(PositiveInt),
    cursor: Schema.optionalKey(Schema.String),
  }),
]);
export type GerritDirectRead = typeof GerritDirectRead.Type;

export const GerritDirectReadRequest = GerritDirectRead;
export type GerritDirectReadRequest = typeof GerritDirectReadRequest.Type;

const uploadOptions = {
  commit: Schema.optionalKey(GitCommitOid),
  topic: Schema.optionalKey(Schema.String),
  reviewers: Schema.optionalKey(Schema.Array(NonEmpty)),
  cc: Schema.optionalKey(Schema.Array(NonEmpty)),
  wip: Schema.optionalKey(Schema.Boolean),
  private: Schema.optionalKey(Schema.Boolean),
};
export const GerritDirectUploadInput = Schema.Union([
  strictStruct({
    kind: Schema.Literal("new"),
    branch: Schema.optionalKey(NonEmpty),
    ...uploadOptions,
  }),
  strictStruct({ kind: Schema.Literal("patch-set"), number: PositiveInt, ...uploadOptions }),
  strictStruct({ kind: Schema.Literal("patch-set"), url: NonEmpty, ...uploadOptions }),
]);
export type GerritDirectUploadInput = typeof GerritDirectUploadInput.Type;
