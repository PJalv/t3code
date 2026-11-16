import {
  GerritChangeNumber,
  GerritInstallationId,
  GerritReadError,
  GerritWriteError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { GerritHttpCredentials } from "./GerritHttp.ts";

type Auth = {
  readonly installation: GerritInstallationId;
  readonly credentials: GerritHttpCredentials;
};
export type GerritDirectTarget = {
  readonly number: number;
  readonly project?: string;
  readonly revision?: string | number;
};
export type GerritDirectComment = {
  readonly path: string | null;
  readonly message: string;
  readonly side?: "REVISION" | "PARENT";
  readonly parent?: number;
  readonly line?: number;
  readonly range?: {
    readonly start_line: number;
    readonly start_character: number;
    readonly end_line: number;
    readonly end_character: number;
  };
  readonly inReplyTo?: string;
  readonly unresolved?: boolean;
  readonly id?: string;
};
export type GerritNotify = "NONE" | "OWNER" | "OWNER_REVIEWERS" | "ALL";
type Request = <S extends Schema.Top & { readonly DecodingServices: never }>(
  auth: Auth,
  path: string,
  schema: S,
  write: { readonly method: "POST" | "PUT" | "DELETE"; readonly body: unknown },
) => Effect.Effect<S["Type"], GerritReadError>;
type GetChange = (
  input: Auth & { readonly number: typeof GerritChangeNumber.Type },
) => Effect.Effect<
  { readonly key: { readonly project: string; readonly changeId: string } },
  GerritReadError
>;
const ReviewResult = Schema.Struct({
  labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Int))),
  error: Schema.optionalKey(Schema.String),
  reviewers: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        error: Schema.optionalKey(Schema.String),
        confirm: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
});
const Changed = Schema.Struct({
  _number: GerritChangeNumber,
  project: Schema.String,
  branch: Schema.String,
  status: Schema.String,
});
const ReviewerResult = Schema.Struct({
  input: Schema.String,
  error: Schema.optionalKey(Schema.String),
  confirm: Schema.optionalKey(Schema.Boolean),
  reviewers: Schema.optionalKey(
    Schema.Array(Schema.Struct({ _account_id: Schema.optionalKey(Schema.Number) })),
  ),
  ccs: Schema.optionalKey(
    Schema.Array(Schema.Struct({ _account_id: Schema.optionalKey(Schema.Number) })),
  ),
});
const Draft = Schema.Struct({
  id: Schema.String,
  path: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  side: Schema.optionalKey(Schema.String),
  parent: Schema.optionalKey(Schema.Number),
  line: Schema.optionalKey(Schema.Number),
  range: Schema.optionalKey(
    Schema.Struct({
      start_line: Schema.Number,
      start_character: Schema.Number,
      end_line: Schema.Number,
      end_character: Schema.Number,
    }),
  ),
  in_reply_to: Schema.optionalKey(Schema.String),
  unresolved: Schema.optionalKey(Schema.Boolean),
});
const decodeChangeNumber = Schema.decodeEffect(GerritChangeNumber);
const sameRange = Schema.toEquivalence(Schema.UndefinedOr(Draft.fields.range.schema));
const invalid = () => new GerritReadError({ reason: "invalid-response" });
const badInput = () => new GerritWriteError({ reason: "invalid-input", notDispatched: true });
const commentBody = (c: GerritDirectComment) => ({
  ...(c.id === undefined ? {} : { id: c.id }),
  ...(c.path === null ? {} : { side: c.side, parent: c.parent, line: c.line, range: c.range }),
  message: c.message,
  in_reply_to: c.inReplyTo,
  unresolved: c.unresolved,
});

export const makeDirectActions = (request: Request, getChange: GetChange) => {
  const prepare = Effect.fn("GerritDirectActions.prepare")(function* (
    auth: Auth,
    target: GerritDirectTarget,
  ) {
    const number = yield* decodeChangeNumber(target.number).pipe(Effect.mapError(badInput));
    if (
      target.revision !== undefined &&
      !/^(?:[1-9][0-9]*|[a-fA-F0-9]{40})$/.test(String(target.revision))
    )
      return yield* badInput();
    if (target.project !== undefined) {
      const change = yield* getChange({ ...auth, number });
      if (change.key.project !== target.project)
        return yield* new GerritReadError({ reason: "identity-mismatch" });
    }
    return {
      number,
      base: `changes/${number}`,
      rev: `changes/${number}/revisions/${target.revision ?? "current"}`,
    };
  });
  const send = <S extends Schema.Top & { readonly DecodingServices: never }>(
    auth: Auth,
    path: string,
    method: "POST" | "PUT" | "DELETE",
    body: unknown,
    schema: S,
  ) => request(auth, path, schema, { method, body });
  const review = Effect.fn("GerritDirectActions.review")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    input: {
      readonly message?: string;
      readonly labels?: Readonly<Record<string, number>>;
      readonly comments?: ReadonlyArray<GerritDirectComment>;
      readonly drafts?: ReadonlyArray<GerritDirectComment>;
      readonly notify?: GerritNotify;
    },
  ) {
    const { rev } = yield* prepare(auth, target);
    const comments: Record<string, unknown[]> = {};
    for (const c of [...(input.comments ?? []), ...(input.drafts ?? [])])
      (comments[c.path ?? "/PATCHSET_LEVEL"] ??= []).push(commentBody(c));
    if (input.drafts?.some((draft) => !draft.id)) return yield* badInput();
    const labels = input.labels ?? {};
    const result = yield* send(
      auth,
      `${rev}/review`,
      "POST",
      {
        message: input.message ?? "",
        labels,
        comments,
        drafts: "KEEP",
        notify: input.notify,
        omit_duplicate_comments: false,
      },
      ReviewResult,
    );
    if (
      result.error !== undefined ||
      result.labels === null ||
      Object.entries(labels).some(([name, value]) => result.labels?.[name] !== value) ||
      Object.values(result.reviewers ?? {}).some((r) => r.error !== undefined || r.confirm === true)
    )
      return yield* invalid();
  });
  const reply = Effect.fn("GerritDirectActions.reply")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    input: {
      readonly comment: GerritDirectComment & { readonly inReplyTo: string };
      readonly notify?: GerritNotify;
    },
  ) {
    yield* review(auth, target, {
      comments: [input.comment],
      ...(input.notify === undefined ? {} : { notify: input.notify }),
    });
  });
  const resolve = Effect.fn("GerritDirectActions.resolve")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    input: {
      readonly comment: Omit<GerritDirectComment, "message" | "unresolved"> & {
        readonly inReplyTo: string;
      };
      readonly message?: string;
      readonly notify?: GerritNotify;
    },
  ) {
    yield* reply(auth, target, {
      comment: { ...input.comment, message: input.message ?? "Done", unresolved: false },
      ...(input.notify === undefined ? {} : { notify: input.notify }),
    });
  });
  const saveDraft = Effect.fn("GerritDirectActions.saveDraft")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    input: { readonly id?: string; readonly comment: GerritDirectComment },
  ) {
    const { rev } = yield* prepare(auth, target);
    if (input.id === "") return yield* badInput();
    const c = input.comment;
    const result = yield* send(
      auth,
      `${rev}/drafts${input.id === undefined ? "" : `/${encodeURIComponent(input.id)}`}`,
      "PUT",
      { ...commentBody(c), path: c.path ?? "/PATCHSET_LEVEL" },
      Draft,
    );
    if (
      !result.id ||
      (input.id !== undefined && result.id !== input.id) ||
      result.message !== c.message ||
      (result.path ?? "/PATCHSET_LEVEL") !== (c.path ?? "/PATCHSET_LEVEL") ||
      (result.side ?? "REVISION") !== (c.side ?? "REVISION") ||
      result.parent !== c.parent ||
      (result.line ?? 0) !== (c.range?.end_line ?? c.line ?? 0) ||
      !sameRange(result.range, c.range) ||
      result.in_reply_to !== c.inReplyTo ||
      result.unresolved !== c.unresolved
    )
      return yield* invalid();
    return result.id;
  });
  const deleteDraft = Effect.fn("GerritDirectActions.deleteDraft")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    id: string,
  ) {
    const { rev } = yield* prepare(auth, target);
    if (!id) return yield* badInput();
    yield* send(auth, `${rev}/drafts/${encodeURIComponent(id)}`, "DELETE", undefined, Schema.Void);
  });
  const setTopic = Effect.fn("GerritDirectActions.setTopic")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    topic: string | null,
  ) {
    const { base } = yield* prepare(auth, target);
    const result = yield* send(
      auth,
      `${base}/topic`,
      "PUT",
      { topic: topic ?? "" },
      Schema.Union([Schema.String, Schema.Void]),
    );
    if ((result ?? "") !== (topic ?? "")) return yield* invalid();
  });
  const addReviewer = Effect.fn("GerritDirectActions.addReviewer")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    input: {
      readonly reviewer: string;
      readonly state: "REVIEWER" | "CC";
      readonly notify?: GerritNotify;
    },
  ) {
    const { base } = yield* prepare(auth, target);
    if (!input.reviewer) return yield* badInput();
    const result = yield* send(auth, `${base}/reviewers`, "POST", input, ReviewerResult);
    if (
      result.input !== input.reviewer ||
      result.error !== undefined ||
      result.confirm === true ||
      (input.state === "CC" ? result.ccs : result.reviewers)?.length !== 1
    )
      return yield* invalid();
  });
  const removeReviewer = Effect.fn("GerritDirectActions.removeReviewer")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    input: { readonly reviewer: string; readonly notify?: GerritNotify },
  ) {
    const { base } = yield* prepare(auth, target);
    if (!input.reviewer) return yield* badInput();
    yield* send(
      auth,
      `${base}/reviewers/${encodeURIComponent(input.reviewer)}/delete`,
      "POST",
      { notify: input.notify },
      Schema.Void,
    );
  });
  const setWip = Effect.fn("GerritDirectActions.setWip")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    wip: boolean,
  ) {
    const { base } = yield* prepare(auth, target);
    yield* send(auth, `${base}/${wip ? "wip" : "ready"}`, "POST", {}, Schema.Void);
  });
  const setPrivate = Effect.fn("GerritDirectActions.setPrivate")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    privateChange: boolean,
    message?: string,
  ) {
    const { base } = yield* prepare(auth, target);
    yield* send(
      auth,
      `${base}/private`,
      privateChange ? "PUT" : "DELETE",
      message === undefined ? undefined : { message },
      Schema.Void,
    );
  });
  const setCommitMessage = Effect.fn("GerritDirectActions.setCommitMessage")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    message: string,
  ) {
    const { base, number } = yield* prepare(auth, target);
    const change = yield* getChange({ ...auth, number });
    const footers =
      message
        .trimEnd()
        .split(/\r?\n\s*\r?\n/)
        .at(-1) ?? "";
    const ids = [...footers.matchAll(/^Change-Id: (I[0-9a-fA-F]{40})\s*$/gm)];
    if (ids.length !== 1 || ids[0]?.[1] !== change.key.changeId) return yield* badInput();
    const result = yield* send(
      auth,
      `${base}/message`,
      "PUT",
      { message: `${message.trimEnd()}\n` },
      Schema.String,
    );
    if (result !== "ok") return yield* invalid();
  });
  const changeAction = Effect.fn("GerritDirectActions.changeAction")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    action: "abandon" | "restore" | "submit" | "rebase",
    body: unknown,
    status: string,
  ) {
    const { base, number } = yield* prepare(auth, target);
    const result = yield* send(auth, `${base}/${action}`, "POST", body, Changed);
    if (
      result._number !== number ||
      (target.project !== undefined && result.project !== target.project) ||
      result.status !== status
    )
      return yield* invalid();
  });
  const abandon = Effect.fn("GerritDirectActions.abandon")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    input: { readonly message?: string; readonly notify?: GerritNotify } = {},
  ) {
    yield* changeAction(auth, target, "abandon", input, "ABANDONED");
  });
  const restore = Effect.fn("GerritDirectActions.restore")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    input: { readonly message?: string; readonly notify?: GerritNotify } = {},
  ) {
    yield* changeAction(auth, target, "restore", input, "NEW");
  });
  const submit = Effect.fn("GerritDirectActions.submit")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    input: { readonly notify?: GerritNotify } = {},
  ) {
    yield* changeAction(auth, target, "submit", input, "MERGED");
  });
  const rebase = Effect.fn("GerritDirectActions.rebase")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    input: { readonly base?: string } = {},
  ) {
    yield* changeAction(auth, target, "rebase", input, "NEW");
  });
  const rebaseChain = Effect.fn("GerritDirectActions.rebaseChain")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    input: { readonly base?: string } = {},
  ) {
    const { base } = yield* prepare(auth, target);
    const result = yield* send(
      auth,
      `${base}/rebase:chain`,
      "POST",
      input,
      Schema.Struct({
        rebased_changes: Schema.Array(Changed).check(Schema.isMaxLength(100)),
        contains_git_conflicts: Schema.optionalKey(Schema.Boolean),
      }),
    ).pipe(
      Effect.mapError((error) =>
        error.status === 404 || error.status === 405
          ? new GerritWriteError({ reason: "unsupported" })
          : error,
      ),
    );
    if (result.contains_git_conflicts || result.rebased_changes.length === 0)
      return yield* invalid();
  });
  const cherryPick = Effect.fn("GerritDirectActions.cherryPick")(function* (
    auth: Auth,
    target: GerritDirectTarget,
    input: { readonly destination: string; readonly message?: string; readonly topic?: string },
  ) {
    const { rev, number } = yield* prepare(auth, target);
    if (!input.destination) return yield* badInput();
    const result = yield* send(auth, `${rev}/cherrypick`, "POST", input, Changed);
    if (
      result._number === number ||
      result.branch !== input.destination ||
      result.status !== "NEW" ||
      (target.project !== undefined && result.project !== target.project)
    )
      return yield* invalid();
    return {
      number: result._number,
      url: new URL(
        `c/${result.project.split("/").map(encodeURIComponent).join("/")}/+/${result._number}`,
        auth.installation,
      ).href,
    };
  });
  return {
    review,
    reply,
    resolve,
    saveDraft,
    deleteDraft,
    setTopic,
    addReviewer,
    removeReviewer,
    setWip,
    setPrivate,
    setCommitMessage,
    abandon,
    restore,
    submit,
    rebase,
    rebaseChain,
    cherryPick,
  };
};
