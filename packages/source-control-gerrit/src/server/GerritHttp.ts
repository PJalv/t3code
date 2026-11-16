import {
  GerritReadError,
  GerritVerification as Verification,
  GerritCapabilities as Capabilities,
  type GerritChangeList as ChangeList,
  type GerritRelatedChanges as RelatedChanges,
} from "@t3tools/contracts";
export { GerritReadError } from "@t3tools/contracts";
export type {
  GerritVerification as Verification,
  GerritChangeList as ChangeList,
  GerritRelatedChanges as RelatedChanges,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import { makeReviewApi } from "./GerritReviewApi.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import {
  GerritAccount,
  GerritChangeId,
  GerritChangeMessage,
  GerritChangeNumber,
  GerritGitPerson,
  GerritInstallationId,
  GerritLabel,
  GerritPatchSetNumber,
  GerritProjectName,
  GerritChangeRevision,
  GerritReadChange,
  GerritRelatedRevision,
  GerritRepositoryScope,
  GerritRequirement,
  GerritSelfAccount,
  GerritChangesSearchInput,
  type GerritChangesSearchResult,
  GerritTargetBranch,
  GitCommitOid,
  NonNegativeInt,
} from "@t3tools/contracts";

export const GerritHttpCredentialValue = Schema.Struct({
  username: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(1024),
    Schema.makeFilter(
      (s) => !s.includes(":") && Array.from(s).every((c) => c >= " " && c !== "\u007f"),
    ),
  ),
  token: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(8192),
    Schema.makeFilter((s) => Array.from(s).every((c) => c >= " " && c !== "\u007f")),
  ),
});
export const GerritHttpCredentials = Schema.Redacted(GerritHttpCredentialValue, {
  disallowJsonEncode: true,
});
export type GerritHttpCredentials = typeof GerritHttpCredentials.Type;

const Auth = Schema.Struct({
  installation: GerritInstallationId,
  credentials: GerritHttpCredentials,
});
type Auth = typeof Auth.Type;
const ListInput = Schema.Struct({
  ...Auth.fields,
  scope: GerritRepositoryScope,
  changeId: Schema.optionalKey(GerritChangeId),
  /** Exact topic filter, combined with project and branch. */
  topic: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
});
const FindInput = Schema.Struct({
  ...Auth.fields,
  project: GerritProjectName,
  changeId: GerritChangeId,
});
const GetInput = Schema.Struct({
  ...Auth.fields,
  key: Schema.Struct({ ...GerritRepositoryScope.fields, changeId: GerritChangeId }),
  number: GerritChangeNumber,
});
const RelatedInput = Schema.Struct({ ...GetInput.fields, revision: GitCommitOid });
const Commit = Schema.Struct({
  parents: Schema.Array(Schema.Struct({ commit: GitCommitOid })),
  author: GerritGitPerson,
  committer: GerritGitPerson,
});
const WireChange = Schema.Struct({
  project: GerritProjectName,
  branch: GerritTargetBranch,
  change_id: GerritChangeId,
  _number: GerritChangeNumber,
  subject: Schema.String,
  status: GerritReadChange.fields.status,
  created: Schema.optionalKey(Schema.String),
  updated: Schema.optionalKey(Schema.String),
  insertions: Schema.optionalKey(NonNegativeInt),
  deletions: Schema.optionalKey(NonNegativeInt),
  work_in_progress: Schema.optionalKey(Schema.Boolean),
  is_private: Schema.optionalKey(Schema.Boolean),
  topic: Schema.optionalKey(Schema.String),
  owner: GerritAccount,
  current_revision: GitCommitOid,
  revisions: Schema.Record(
    GitCommitOid,
    Schema.Struct({
      _number: GerritPatchSetNumber,
      commit: Commit,
      created: Schema.optionalKey(Schema.String),
      uploader: Schema.optionalKey(GerritAccount),
    }),
  ),
  _more_changes: Schema.optionalKey(Schema.Boolean),
});
/**
 * One row of a batched watch query. `updated` is the authoritative change cursor; labels, messages,
 * comment totals, and mergeability are only used to decide that a full read is needed, never to
 * write a watch baseline by themselves.
 */
export const GerritPolledChange = Schema.Struct({
  installation: GerritInstallationId,
  project: GerritProjectName,
  branch: GerritTargetBranch,
  changeId: GerritChangeId,
  number: GerritChangeNumber,
  currentRevision: GitCommitOid,
  currentPatchSet: Schema.NullOr(GerritPatchSetNumber),
  status: GerritReadChange.fields.status,
  updated: Schema.NullOr(Schema.String),
  mergeable: Schema.NullOr(Schema.Boolean),
  totalCommentCount: Schema.NullOr(NonNegativeInt),
  unresolvedCommentCount: Schema.NullOr(NonNegativeInt),
  labels: Schema.Record(Schema.String, GerritLabel),
  messages: Schema.Array(GerritChangeMessage),
  requirements: Schema.NullOr(Schema.Array(GerritRequirement)),
});
export type GerritPolledChange = typeof GerritPolledChange.Type;

export const GerritWatchSnapshot = Schema.Struct({
  changes: Schema.Array(GerritPolledChange),
  /** Numbers the caller asked for that the authenticated account cannot see. */
  missing: Schema.Array(GerritChangeNumber),
  complete: Schema.Boolean,
});
export type GerritWatchSnapshot = typeof GerritWatchSnapshot.Type;

const WirePolledChange = Schema.Struct({
  project: GerritProjectName,
  branch: GerritTargetBranch,
  change_id: GerritChangeId,
  _number: GerritChangeNumber,
  status: GerritReadChange.fields.status,
  current_revision: GitCommitOid,
  current_revision_number: Schema.optionalKey(GerritPatchSetNumber),
  updated: Schema.optionalKey(Schema.String),
  mergeable: Schema.optionalKey(Schema.Boolean),
  total_comment_count: Schema.optionalKey(NonNegativeInt),
  unresolved_comment_count: Schema.optionalKey(NonNegativeInt),
  labels: Schema.optionalKey(Schema.Record(Schema.String, GerritLabel)),
  messages: Schema.optionalKey(Schema.Array(GerritChangeMessage)),
  submit_requirements: Schema.optionalKey(Schema.Array(GerritRequirement)),
  _more_changes: Schema.optionalKey(Schema.Boolean),
});

const SubmittedTogether = Schema.Struct({
  changes: Schema.Array(
    Schema.Struct({
      project: GerritProjectName,
      branch: GerritTargetBranch,
      change_id: GerritChangeId,
      _number: GerritChangeNumber,
      current_revision: GitCommitOid,
      current_revision_number: Schema.optionalKey(GerritPatchSetNumber),
    }),
  ).check(Schema.isMaxLength(200)),
  non_visible_changes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
const WireRelated = Schema.Struct({
  project: GerritProjectName,
  change_id: Schema.optionalKey(GerritChangeId),
  _change_number: Schema.optionalKey(GerritChangeNumber),
  _revision_number: Schema.optionalKey(GerritPatchSetNumber),
  _current_revision_number: Schema.optionalKey(GerritPatchSetNumber),
  status: Schema.optionalKey(GerritReadChange.fields.status),
  work_in_progress: Schema.optionalKey(Schema.Boolean),
  commit: Schema.Struct({
    commit: GitCommitOid,
    parents: Commit.fields.parents,
    author: GerritGitPerson,
    committer: Schema.optionalKey(GerritGitPerson),
    subject: Schema.String,
  }),
});
export class GerritHttp extends Context.Service<
  GerritHttp,
  {
    readonly review: ReturnType<typeof makeReviewApi>;
    readonly directWrite: <S extends Schema.Top & { readonly DecodingServices: never }>(
      auth: Auth,
      path: string,
      schema: S,
      write: { readonly method: "POST" | "PUT" | "DELETE"; readonly body: unknown },
    ) => Effect.Effect<S["Type"], GerritReadError>;
    readonly downloadCloneHook: (
      installation: GerritInstallationId,
    ) => Effect.Effect<Uint8Array, GerritReadError>;
    readonly verify: (input: Auth) => Effect.Effect<Verification, GerritReadError>;
    readonly readBranchTip: (
      input: Auth & { readonly scope: GerritRepositoryScope },
    ) => Effect.Effect<GitCommitOid, GerritReadError>;
    /** The account these credentials authenticate as, so a watch can skip its own activity. */
    readonly readSelfAccount: (
      input: Auth,
    ) => Effect.Effect<typeof GerritSelfAccount.Type, GerritReadError>;
    readonly searchChanges: (
      input: Auth &
        Omit<GerritChangesSearchInput, "status"> & {
          readonly status: GerritChangesSearchInput["status"] | "all";
        },
    ) => Effect.Effect<
      GerritChangesSearchResult & {
        readonly changes: ReadonlyArray<
          GerritChangesSearchResult["changes"][number] & {
            readonly created?: string;
            readonly insertions?: number;
            readonly deletions?: number;
            readonly currentPatchSet?: number;
          }
        >;
      },
      GerritReadError
    >;
    readonly listChanges: (
      input: typeof ListInput.Type,
    ) => Effect.Effect<ChangeList, GerritReadError>;
    /** Find every visible change in a project with this Change-Id, independent of branch. */
    readonly findChangesByChangeId: (
      input: typeof FindInput.Type,
    ) => Effect.Effect<ReadonlyArray<GerritReadChange>, GerritReadError>;
    readonly searchProjects: (
      input: Auth & { readonly query: string },
    ) => Effect.Effect<ReadonlyArray<string>, GerritReadError>;
    readonly getChangeByNumber: (
      input: Auth & { readonly number: typeof GerritChangeNumber.Type },
    ) => Effect.Effect<
      GerritReadChange & {
        readonly created?: string;
        readonly updated?: string;
        readonly insertions?: number;
        readonly deletions?: number;
        readonly isPrivate: boolean;
        readonly patchSetDetails: ReadonlyArray<{
          readonly number: number;
          readonly commit: string;
          readonly created?: string | undefined;
          readonly uploader?: typeof GerritAccount.Type | undefined;
        }>;
      },
      GerritReadError
    >;
    readonly getChange: (
      input: typeof GetInput.Type,
    ) => Effect.Effect<GerritReadChange, GerritReadError>;
    readonly getRelatedChanges: (
      input: typeof RelatedInput.Type,
    ) => Effect.Effect<RelatedChanges, GerritReadError>;
    /** Same-topic submit closure with Gerrit's own non-visible count. Read-only. */
    readonly readSubmittedTogether: (input: {
      readonly installation: GerritInstallationId;
      readonly credentials: GerritHttpCredentials;
      readonly number: typeof GerritChangeNumber.Type;
    }) => Effect.Effect<
      {
        readonly changes: ReadonlyArray<GerritChangeRevision>;
        readonly nonVisibleChanges: number;
      },
      GerritReadError
    >;
    /**
     * One query for every watched change number on one installation. Gerrit's `change:` operator
     * accepts change numbers and OR-combined terms; numbers are chunked because query URLs are
     * bounded. A number absent from the response is reported as missing rather than deleted.
     */
    readonly readWatchChanges: (input: {
      readonly installation: GerritInstallationId;
      readonly credentials: GerritHttpCredentials;
      readonly numbers: ReadonlyArray<typeof GerritChangeNumber.Type>;
    }) => Effect.Effect<GerritWatchSnapshot, GerritReadError>;
  }
>()("@t3tools/source-control-gerrit/server/GerritHttp") {}

const decodeSearch = Schema.decodeEffect(
  Schema.Struct({
    ...GerritChangesSearchInput.fields,
    status: Schema.Literals(["open", "merged", "abandoned", "all"]),
  }),
);
const decodeAuth = Schema.decodeEffect(Auth);
const decodeChangeNumber = Schema.decodeEffect(GerritChangeNumber);
const decodeListInput = Schema.decodeEffect(ListInput);
const decodeFindInput = Schema.decodeEffect(FindInput);
const decodeGetInput = Schema.decodeEffect(GetInput);
const decodeRelatedInput = Schema.decodeEffect(RelatedInput);
const decodeReadChange = Schema.decodeUnknownEffect(GerritReadChange);
const decodeRelatedRevision = Schema.decodeUnknownEffect(GerritRelatedRevision);
const isReadError = Schema.is(GerritReadError);

const literal = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const options = ["ALL_REVISIONS", "ALL_COMMITS", "DETAILED_ACCOUNTS"];
const invalidResponse = () => new GerritReadError({ reason: "invalid-response" });

const normalizeChange = Effect.fn("GerritHttp.normalizeChange")(function* (
  wire: typeof WireChange.Type,
  scope: GerritRepositoryScope,
) {
  if (wire.project !== scope.project || wire.branch !== scope.branch) {
    return yield* new GerritReadError({ reason: "identity-mismatch" });
  }
  const revisions = Object.entries(wire.revisions).map(([commit, revision]) => ({
    commit,
    patchSet: revision._number,
    parents: revision.commit.parents.map((parent) => parent.commit),
    author: revision.commit.author,
    committer: revision.commit.committer,
  }));
  const current = wire.revisions[wire.current_revision];
  if (
    current === undefined ||
    new Set(revisions.map((r) => r.patchSet)).size !== revisions.length
  ) {
    return yield* invalidResponse();
  }
  const change = yield* decodeReadChange({
    key: { ...scope, changeId: wire.change_id },
    number: wire._number,
    subject: wire.subject,
    status: wire.status,
    workInProgress: wire.work_in_progress ?? false,
    ...(wire.topic === undefined ? {} : { topic: wire.topic }),
    owner: wire.owner,
    currentRevision: wire.current_revision,
    currentPatchSet: current._number,
    revisions,
  }).pipe(Effect.mapError(invalidResponse));
  return {
    ...change,
    isPrivate: wire.is_private ?? false,
    patchSetDetails: Object.entries(wire.revisions).map(([commit, revision]) => ({
      number: revision._number,
      commit,
      created: revision.created,
      uploader: revision.uploader,
    })),
    ...(wire.created === undefined ? {} : { created: wire.created }),
    ...(wire.updated === undefined ? {} : { updated: wire.updated }),
    ...(wire.insertions === undefined ? {} : { insertions: wire.insertions }),
    ...(wire.deletions === undefined ? {} : { deletions: wire.deletions }),
  };
});

const make = Effect.gen(function* () {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const request = Effect.fn("GerritHttp.request")(function* <
    S extends Schema.Top & { readonly DecodingServices: never },
  >(
    auth: Auth,
    path: string,
    schema: S,
    parameters: ReadonlyArray<readonly [string, string]> = [],
    write?: { readonly method: "POST" | "PUT" | "DELETE"; readonly body: unknown },
  ) {
    const url = new URL(`a/${path}`, auth.installation);
    for (const [key, value] of parameters) url.searchParams.append(key, value);
    const credentials = Redacted.value(auth.credentials);
    const header = `Basic ${Buffer.from(`${credentials.username}:${credentials.token}`, "utf8").toString("base64")}`;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const base = HttpClientRequest.make(write?.method ?? "GET")(url.href).pipe(
          HttpClientRequest.setHeader("Authorization", header),
          HttpClientRequest.setHeader("Accept", "application/json"),
        );
        const outgoing =
          write?.body === undefined
            ? base
            : yield* HttpClientRequest.bodyJson(base, write.body).pipe(
                Effect.mapError(invalidResponse),
              );
        const response = yield* http
          .execute(outgoing)
          .pipe(Effect.mapError(() => new GerritReadError({ reason: "offline" })));
        const status = response.status;
        if (status !== 200 && !(write !== undefined && (status === 201 || status === 204))) {
          let detail: string | undefined;
          if (status === 409 && write !== undefined) {
            const chunks: Uint8Array[] = [];
            let size = 0;
            yield* response.stream.pipe(
              Stream.runForEach((chunk) => {
                const remaining = 4096 - size;
                if (remaining > 0) chunks.push(chunk.slice(0, remaining));
                size += chunk.length;
                return size >= 4096 ? Effect.fail("bounded") : Effect.void;
              }),
              Effect.ignoreCause,
            );
            const text = new TextDecoder()
              .decode(Buffer.concat(chunks))
              .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
              .slice(0, 4096)
              .trim();
            if (text) detail = text;
          }
          return yield* new GerritReadError({
            status,
            ...(detail === undefined ? {} : { detail }),
            reason:
              status === 401
                ? "authentication"
                : status === 403
                  ? "forbidden"
                  : status === 404
                    ? "not-found-or-hidden"
                    : status === 429
                      ? "rate-limit"
                      : status >= 300 && status < 400
                        ? "redirect"
                        : "http",
          });
        }
        if (status === 204)
          return yield* Schema.decodeEffect(schema)(undefined).pipe(
            Effect.mapError(invalidResponse),
          );
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        yield* response.stream.pipe(
          Stream.runForEach((chunk) => {
            bytes += chunk.byteLength;
            if (bytes > 4 * 1024 * 1024)
              return Effect.fail(new GerritReadError({ reason: "oversize" }));
            chunks.push(chunk);
            return Effect.void;
          }),
          Effect.mapError((error) =>
            isReadError(error) ? error : new GerritReadError({ reason: "offline" }),
          ),
        );
        const text = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)),
          catch: invalidResponse,
        });
        if (!text.startsWith(")]}'\n")) return yield* invalidResponse();
        return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text.slice(5)).pipe(
          Effect.mapError(invalidResponse),
        );
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(new GerritReadError({ reason: "timeout" })),
      }),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit",
      }),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    );
  });
  const downloadCloneHook = Effect.fn("GerritHttp.downloadCloneHook")(function* (
    installation: GerritInstallationId,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const url = new URL("tools/hooks/commit-msg", installation);
        const response = yield* http
          .execute(HttpClientRequest.get(url.href))
          .pipe(Effect.mapError(() => new GerritReadError({ reason: "offline" })));
        if (response.status !== 200)
          return yield* new GerritReadError({
            reason: response.status >= 300 && response.status < 400 ? "redirect" : "http",
            status: response.status,
          });
        const chunks: Uint8Array[] = [];
        let size = 0;
        yield* response.stream.pipe(
          Stream.runForEach((chunk) => {
            size += chunk.length;
            if (size > 65536) return Effect.fail(new GerritReadError({ reason: "oversize" }));
            chunks.push(chunk);
            return Effect.void;
          }),
          Effect.mapError((error) =>
            isReadError(error) ? error : new GerritReadError({ reason: "offline" }),
          ),
        );
        if (size === 0) return yield* new GerritReadError({ reason: "invalid-response" });
        return new Uint8Array(Buffer.concat(chunks, size));
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(new GerritReadError({ reason: "timeout" })),
      }),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit",
      }),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    );
  });
  const readBranchTip = Effect.fn("GerritHttp.readBranchTip")(function* (
    input: Auth & { readonly scope: GerritRepositoryScope },
  ) {
    if (input.installation !== input.scope.installation)
      return yield* new GerritReadError({ reason: "identity-mismatch" });
    const result = yield* request(
      input,
      `projects/${encodeURIComponent(input.scope.project)}/branches/${encodeURIComponent(input.scope.branch)}`,
      Schema.Struct({ revision: GitCommitOid }),
    );
    return result.revision;
  });
  const readSelfAccount = Effect.fn("GerritHttp.readSelfAccount")(function* (raw: Auth) {
    const auth = yield* decodeAuth(raw).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    return yield* request(auth, "accounts/self", GerritSelfAccount);
  });
  const verify = Effect.fn("GerritHttp.verify")(function* (input: Auth) {
    const auth = yield* decodeAuth(input).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    const account = yield* request(auth, "accounts/self", GerritSelfAccount);
    const version = yield* request(
      auth,
      "config/server/version",
      Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
    ).pipe(Effect.result);
    if (
      Result.isFailure(version) &&
      (version.failure.reason === "authentication" || version.failure.reason === "forbidden")
    )
      return yield* version.failure;
    const capabilities = yield* request(auth, "accounts/self/capabilities", Capabilities).pipe(
      Effect.result,
    );
    if (Result.isFailure(capabilities) && capabilities.failure.reason === "authentication")
      return yield* capabilities.failure;
    return {
      installation: auth.installation,
      account,
      version: Result.isSuccess(version)
        ? { kind: "observed", value: version.success }
        : { kind: "unknown", error: version.failure },
      capabilities: Result.isSuccess(capabilities)
        ? { kind: "observed", values: capabilities.success }
        : { kind: "unknown", error: capabilities.failure },
      observedAt: DateTime.formatIso(yield* DateTime.now),
      compatibility: "unverified",
    } satisfies Verification;
  });
  const searchChanges = Effect.fn("GerritHttp.searchChanges")(function* (
    input: Auth &
      Omit<GerritChangesSearchInput, "status"> & {
        readonly status: GerritChangesSearchInput["status"] | "all";
      },
  ) {
    const auth = yield* decodeAuth(input).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    const query = yield* decodeSearch(input).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    const terms = [
      query.status === "all"
        ? "(status:open OR status:merged OR status:abandoned)"
        : `status:${query.status}`,
    ];
    for (const [operator, value] of [
      ["project", query.project],
      ["branch", query.branch],
      ["owner", query.owner],
      ["topic", query.topic],
      ["message", query.search],
    ] as const) {
      if (value !== undefined) terms.push(`${operator}:${literal(value)}`);
    }
    const rowSchema = Schema.Struct({
      project: GerritProjectName,
      branch: GerritTargetBranch,
      change_id: GerritChangeId,
      _number: GerritChangeNumber,
      subject: Schema.String,
      status: GerritReadChange.fields.status,
      owner: GerritAccount,
      topic: Schema.optionalKey(Schema.String),
      updated: Schema.String,
      created: Schema.optionalKey(Schema.String),
      insertions: Schema.optionalKey(NonNegativeInt),
      deletions: Schema.optionalKey(NonNegativeInt),
      work_in_progress: Schema.optionalKey(Schema.Boolean),
      current_revision_number: Schema.optionalKey(GerritPatchSetNumber),
      _more_changes: Schema.optionalKey(Schema.Boolean),
    });
    const rows = yield* request(auth, "changes/", Schema.Array(rowSchema), [
      ["q", terms.join(" ")],
      ["o", "DETAILED_ACCOUNTS"],
      ["n", String(query.limit)],
      ["S", String(query.offset)],
    ]);
    const expected = query.status === "open" ? "NEW" : query.status.toUpperCase();
    if (
      rows.length > query.limit ||
      rows.some(
        (row, index) =>
          (row._more_changes === true && index !== rows.length - 1) ||
          (query.status !== "all" && row.status !== expected) ||
          (query.project !== undefined && row.project !== query.project) ||
          (query.branch !== undefined &&
            row.branch !== query.branch.replace(/^refs\/heads\//, "")) ||
          (query.topic !== undefined && row.topic !== query.topic),
      ) ||
      new Set(rows.map((row) => row._number)).size !== rows.length
    )
      return yield* new GerritReadError({ reason: "identity-mismatch" });
    const more = rows.at(-1)?._more_changes === true;
    const nextOffset = query.offset + rows.length;
    const completeness = !more ? "complete" : nextOffset <= 10000 ? "more" : "truncated";
    return {
      changes: rows.map((row) => ({
        installation: auth.installation,
        project: row.project,
        branch: row.branch,
        changeId: row.change_id,
        number: row._number,
        subject: row.subject,
        status: row.status,
        owner: row.owner,
        ...(row.topic === undefined ? {} : { topic: row.topic }),
        updated: row.updated,
        ...(row.created === undefined ? {} : { created: row.created }),
        ...(row.insertions === undefined ? {} : { insertions: row.insertions }),
        ...(row.deletions === undefined ? {} : { deletions: row.deletions }),
        ...(row.current_revision_number === undefined
          ? {}
          : { currentPatchSet: row.current_revision_number }),
        workInProgress: row.work_in_progress ?? false,
      })),
      nextOffset: completeness === "more" ? nextOffset : null,
      completeness,
    } satisfies GerritChangesSearchResult;
  });
  const listChanges = Effect.fn("GerritHttp.listChanges")(function* (input: typeof ListInput.Type) {
    const auth = yield* decodeListInput(input).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    if (
      auth.installation !== auth.scope.installation ||
      auth.scope.project.startsWith("^") ||
      auth.scope.branch.startsWith("^") ||
      Array.from(auth.scope.project + auth.scope.branch).some((c) => c < " " || c === "\u007f")
    )
      return yield* new GerritReadError({ reason: "invalid-input" });
    const q = `project:${literal(auth.scope.project)} branch:${literal(auth.scope.branch)}${auth.changeId === undefined ? "" : ` change:${literal(auth.changeId)}`}${auth.topic === undefined ? "" : ` topic:${literal(auth.topic)}`}`;
    const changes: GerritReadChange[] = [];
    const seen = new Set<number>();
    let issue: ChangeList["issue"];
    let complete = false;
    let start = 0;
    for (let page = 0; page < 20; page++) {
      const result = yield* request(auth, "changes/", Schema.Array(WireChange), [
        ["q", q],
        ["n", "100"],
        ["S", String(start)],
        ...options.map((o): readonly [string, string] => ["o", o]),
      ]).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            normalizeChange(row, auth.scope).pipe(Effect.map((change) => ({ row, change }))),
          ),
        ),
        Effect.result,
      );
      if (Result.isFailure(result)) {
        if (page === 0) return yield* result.failure;
        issue = result.failure;
        break;
      }
      const rows = result.success;
      if (
        rows.length > 100 ||
        rows.some(({ row }, index) => row._more_changes === true && index !== rows.length - 1)
      ) {
        issue = invalidResponse();
        break;
      }
      for (const { change } of rows) {
        if (auth.changeId !== undefined && change.key.changeId !== auth.changeId) {
          issue = new GerritReadError({ reason: "identity-mismatch" });
          break;
        }
        if (auth.topic !== undefined && (change.topic ?? "") !== auth.topic) {
          issue = new GerritReadError({ reason: "identity-mismatch" });
          break;
        }
        if (seen.has(change.number)) {
          issue = "duplicate-results";
          continue;
        }
        seen.add(change.number);
        changes.push(change);
      }
      if (issue !== undefined) break;
      start += rows.length;
      if (rows.at(-1)?.row._more_changes !== true) {
        complete = true;
        break;
      }
      issue = "page-limit";
      if (page < 19) issue = undefined;
    }
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    return {
      changes,
      observation: {
        changes: changes.map((change) => {
          return {
            key: change.key,
            number: change.number,
            revision: { commit: change.currentRevision, patchSet: change.currentPatchSet },
          };
        }),
        observedAt,
        completeness: complete ? "complete-visible" : "partial",
      },
      ...(issue === undefined ? {} : { issue }),
    } satisfies ChangeList;
  });
  const watchQueryOptions = [
    "CURRENT_REVISION",
    "DETAILED_LABELS",
    "MESSAGES",
    "SUBMIT_REQUIREMENTS",
    "DETAILED_ACCOUNTS",
    "SKIP_DIFFSTAT",
  ] as const;
  const WATCH_QUERY_CHUNK = 50;
  const WATCH_QUERY_MAX_NUMBERS = 500;
  const decodePolledChange = Schema.decodeUnknownEffect(GerritPolledChange);
  const readWatchChanges = Effect.fn("GerritHttp.readWatchChanges")(function* (input: {
    readonly installation: GerritInstallationId;
    readonly credentials: GerritHttpCredentials;
    readonly numbers: ReadonlyArray<typeof GerritChangeNumber.Type>;
  }) {
    const auth = yield* decodeAuth({
      installation: input.installation,
      credentials: input.credentials,
    }).pipe(Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })));
    const numbers = [...new Set(input.numbers)];
    if (
      numbers.length > WATCH_QUERY_MAX_NUMBERS ||
      numbers.some((number) => !Number.isSafeInteger(number) || number <= 0)
    )
      return yield* new GerritReadError({ reason: "invalid-input" });
    if (numbers.length === 0) return { changes: [], missing: [], complete: true };
    const byNumber = new Map<number, GerritPolledChange>();
    for (let offset = 0; offset < numbers.length; offset += WATCH_QUERY_CHUNK) {
      const chunk = numbers.slice(offset, offset + WATCH_QUERY_CHUNK);
      const requested = new Set<number>(chunk);
      // `change:` accepts a number, and OR combines exact terms. The chunk keeps the query URL
      // bounded; >50 watched changes therefore use documented, sequential chunks, not one change
      // request apiece.
      const q = chunk.map((number) => `change:${number}`).join(" OR ");
      let start = 0;
      for (let page = 0; page < 20; page++) {
        const rows = yield* request(auth, "changes/", Schema.Array(WirePolledChange), [
          ["q", q],
          ["n", String(chunk.length)],
          ["S", String(start)],
          ...watchQueryOptions.map((option): readonly [string, string] => ["o", option]),
        ]);
        if (
          rows.length > chunk.length ||
          rows.some((row) => !requested.has(row._number)) ||
          rows.some((row) => byNumber.has(row._number))
        )
          return yield* invalidResponse();
        for (const row of rows) {
          byNumber.set(
            row._number,
            yield* decodePolledChange({
              installation: auth.installation,
              project: row.project,
              branch: row.branch,
              changeId: row.change_id,
              number: row._number,
              currentRevision: row.current_revision,
              currentPatchSet: row.current_revision_number ?? null,
              status: row.status,
              updated: row.updated ?? null,
              mergeable: row.mergeable ?? null,
              totalCommentCount: row.total_comment_count ?? null,
              unresolvedCommentCount: row.unresolved_comment_count ?? null,
              labels: row.labels ?? {},
              messages: row.messages ?? [],
              requirements: row.submit_requirements ?? null,
            }).pipe(Effect.mapError(invalidResponse)),
          );
        }
        const more = rows.at(-1)?._more_changes === true;
        if (!more) break;
        if (rows.length === 0) return yield* invalidResponse();
        start += rows.length;
        if (page === 19) return yield* invalidResponse();
      }
    }
    const missing = numbers.filter((number) => !byNumber.has(number));
    return { changes: [...byNumber.values()], missing, complete: missing.length === 0 };
  });
  const findChangesByChangeId = Effect.fn("GerritHttp.findChangesByChangeId")(function* (
    input: typeof FindInput.Type,
  ) {
    const auth = yield* decodeFindInput(input).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    if (
      auth.project.startsWith("^") ||
      Array.from(auth.project).some((character) => character < " " || character === "\u007f")
    )
      return yield* new GerritReadError({ reason: "invalid-input" });
    const q = `project:${literal(auth.project)} change:${literal(auth.changeId)}`;
    const rows = yield* request(auth, "changes/", Schema.Array(WireChange), [
      ["q", q],
      ["n", "100"],
      ...options.map((o): readonly [string, string] => ["o", o]),
    ]);
    if (rows.length > 100 || rows.some((row) => row._more_changes === true))
      return yield* invalidResponse();
    const changes: GerritReadChange[] = [];
    for (const row of rows) {
      if (row.project !== auth.project || row.change_id !== auth.changeId)
        return yield* new GerritReadError({ reason: "identity-mismatch" });
      changes.push(
        yield* normalizeChange(row, {
          installation: auth.installation,
          project: auth.project,
          branch: row.branch,
        }),
      );
    }
    return changes;
  });
  const getChange = Effect.fn("GerritHttp.getChange")(function* (input: typeof GetInput.Type) {
    const auth = yield* decodeGetInput(input).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    if (auth.installation !== auth.key.installation)
      return yield* new GerritReadError({ reason: "invalid-input" });
    const wire = yield* request(
      auth,
      `changes/${auth.number}/detail`,
      WireChange,
      options.map((o) => ["o", o]),
    );
    const change = yield* normalizeChange(wire, auth.key);
    if (change.number !== auth.number || change.key.changeId !== auth.key.changeId)
      return yield* new GerritReadError({ reason: "identity-mismatch" });
    return change;
  });
  const getChangeByNumber = Effect.fn("GerritHttp.getChangeByNumber")(function* (
    input: Auth & { readonly number: typeof GerritChangeNumber.Type },
  ) {
    const auth = yield* decodeAuth(input).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    const number = yield* decodeChangeNumber(input.number).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    const wire = yield* request(
      auth,
      `changes/${number}/detail`,
      WireChange,
      options.map((o) => ["o", o]),
    );
    if (wire._number !== number) return yield* new GerritReadError({ reason: "identity-mismatch" });
    return yield* normalizeChange(wire, {
      installation: auth.installation,
      project: wire.project,
      branch: wire.branch,
    });
  });
  const getRelatedChanges = Effect.fn("GerritHttp.getRelatedChanges")(function* (
    input: typeof RelatedInput.Type,
  ) {
    const auth = yield* decodeRelatedInput(input).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    const anchor = yield* getChange(auth);
    if (!anchor.revisions.some((revision) => revision.commit === auth.revision))
      return yield* new GerritReadError({ reason: "identity-mismatch" });
    const wire = yield* request(
      auth,
      `changes/${auth.number}/revisions/${auth.revision}/related`,
      Schema.Struct({ changes: Schema.Array(WireRelated).check(Schema.isMaxLength(2000)) }),
    );
    const revisions = yield* Effect.forEach(wire.changes, (row) =>
      decodeRelatedRevision({
        installation: auth.installation,
        project: row.project,
        commit: row.commit.commit,
        parents: row.commit.parents.map((parent) => parent.commit),
        author: row.commit.author,
        subject: row.commit.subject,
        ...(row.commit.committer === undefined ? {} : { committer: row.commit.committer }),
        ...(row.change_id === undefined ? {} : { changeId: row.change_id }),
        ...(row._change_number === undefined ? {} : { number: row._change_number }),
        ...(row._revision_number === undefined ? {} : { patchSet: row._revision_number }),
        ...(row._current_revision_number === undefined
          ? {}
          : { currentPatchSet: row._current_revision_number }),
        ...(row.status === undefined ? {} : { status: row.status }),
        ...(row.work_in_progress === undefined ? {} : { workInProgress: row.work_in_progress }),
      }).pipe(Effect.mapError(invalidResponse)),
    );
    return {
      anchor,
      revisions,
      completeness: "complete-visible",
      observedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies RelatedChanges;
  });
  const readSubmittedTogether = Effect.fn("GerritHttp.readSubmittedTogether")(function* (input: {
    readonly installation: GerritInstallationId;
    readonly credentials: GerritHttpCredentials;
    readonly number: typeof GerritChangeNumber.Type;
  }) {
    const auth = yield* decodeAuth(input).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    const number = yield* decodeChangeNumber(input.number).pipe(
      Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
    );
    const closure = yield* request(
      auth,
      `changes/${number}/submitted_together`,
      SubmittedTogether,
      [
        ["o", "NON_VISIBLE_CHANGES"],
        ["o", "CURRENT_REVISION"],
      ],
    );
    return {
      changes: closure.changes.flatMap((change) =>
        change.current_revision_number === undefined
          ? []
          : [
              {
                key: {
                  installation: auth.installation,
                  project: change.project,
                  branch: change.branch,
                  changeId: change.change_id,
                },
                number: change._number,
                revision: {
                  commit: change.current_revision,
                  patchSet: change.current_revision_number,
                },
              },
            ],
      ),
      nonVisibleChanges: closure.non_visible_changes ?? 0,
    };
  });
  return GerritHttp.of({
    downloadCloneHook,
    verify,
    searchChanges,
    listChanges,
    readWatchChanges,
    readBranchTip,
    readSelfAccount,
    readSubmittedTogether,
    findChangesByChangeId,
    searchProjects: Effect.fn("GerritHttp.searchProjects")(function* (
      input: Auth & { readonly query: string },
    ) {
      const auth = yield* decodeAuth(input).pipe(
        Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
      );
      const rows = yield* request(auth, "projects/", Schema.Record(Schema.String, Schema.Unknown), [
        ["m", input.query],
        ["n", "1000"],
      ]);
      const query = input.query.toLocaleLowerCase();
      return Object.keys(rows).filter((project) => project.toLocaleLowerCase().includes(query));
    }),
    getChange,
    getChangeByNumber,
    getRelatedChanges,
    review: makeReviewApi(request, getChange),
    directWrite: Effect.fn("GerritHttp.directWrite")(function* (auth, path, schema, write) {
      if (
        !/^changes\/[1-9][0-9]*\/(?:revisions\/(?:current|[1-9][0-9]*|[a-fA-F0-9]{40})\/(?:review|drafts(?:\/[^/]+)?|cherrypick)|reviewers(?:\/[^/]+\/delete)?|topic|wip|ready|private|message|abandon|restore|submit|rebase|rebase:chain)$/.test(
          path,
        )
      )
        return yield* new GerritReadError({ reason: "invalid-input" });
      const verified = yield* decodeAuth(auth).pipe(
        Effect.mapError(() => new GerritReadError({ reason: "invalid-input" })),
      );
      return yield* request(verified, path, schema, [], write);
    }),
  });
});

export const layer = Layer.effect(GerritHttp, make);
