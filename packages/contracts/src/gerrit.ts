import * as Schema from "effect/Schema";
import { IsoDateTime, PositiveInt } from "./baseSchemas.ts";

export const GerritInstallationId = Schema.String.check(
  Schema.makeFilter((value: string) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      !value.includes("?") &&
      !value.includes("#") &&
      url.pathname.endsWith("/") &&
      url.href === value
    );
  }),
).pipe(Schema.brand("GerritInstallationId"));
export type GerritInstallationId = typeof GerritInstallationId.Type;

const ExactName = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter(
    (value: string) => value === value.trim() && !value.includes("\0") && !/[\r\n]/.test(value),
  ),
);
export const GerritProjectName = ExactName.pipe(Schema.brand("GerritProjectName"));
export type GerritProjectName = typeof GerritProjectName.Type;

export const GerritProjectSearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(256)),
});
export const GerritProjectSearchResult = Schema.Struct({
  configuredInstallations: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  results: Schema.Array(
    Schema.Struct({
      installation: GerritInstallationId,
      project: GerritProjectName,
      httpUrl: Schema.String,
      projectUrl: Schema.optionalKey(Schema.String),
      sshUrl: Schema.String,
      preferredTransport: Schema.optionalKey(Schema.Literal("ssh")),
    }),
  ),
  failures: Schema.Array(
    Schema.Struct({
      installation: GerritInstallationId,
      detail: Schema.String,
    }),
  ),
});
export type GerritProjectSearchResult = typeof GerritProjectSearchResult.Type;
export const GerritTargetBranch = ExactName.pipe(Schema.brand("GerritTargetBranch"));
export const GerritChangeId = Schema.String.check(
  Schema.isPattern(/^I[0-9a-fA-F]{40}$/),
  Schema.makeFilter((value: string) => value !== `I${"0".repeat(40)}`),
).pipe(Schema.brand("GerritChangeId"));
export const GitCommitOid = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
).pipe(Schema.brand("GitCommitOid"));
export type GitCommitOid = typeof GitCommitOid.Type;
export const GerritChangeNumber = PositiveInt.pipe(Schema.brand("GerritChangeNumber"));
export const GerritPatchSetNumber = PositiveInt.pipe(Schema.brand("GerritPatchSetNumber"));

export const GerritRepositoryScope = Schema.Struct({
  installation: GerritInstallationId,
  project: GerritProjectName,
  branch: GerritTargetBranch,
});
export type GerritRepositoryScope = typeof GerritRepositoryScope.Type;

export const GerritChangeKey = Schema.Struct({
  ...GerritRepositoryScope.fields,
  changeId: GerritChangeId,
});
export type GerritChangeKey = typeof GerritChangeKey.Type;

export const GerritChangeRevision = Schema.Struct({
  key: GerritChangeKey,
  number: GerritChangeNumber,
  revision: Schema.Struct({
    commit: GitCommitOid,
    patchSet: GerritPatchSetNumber,
  }),
});
export type GerritChangeRevision = typeof GerritChangeRevision.Type;

export const GerritVisibleChanges = Schema.Struct({
  changes: Schema.Array(GerritChangeRevision),
  observedAt: IsoDateTime,
  completeness: Schema.Literals(["complete-visible", "partial"]),
});
export type GerritVisibleChanges = typeof GerritVisibleChanges.Type;

const IdentityProblem = Schema.Literals([
  "missing-change-id",
  "malformed-change-id",
  "duplicate-change-id",
  "unsupported-link-trailer",
  "duplicate-local-change-id",
]);
export const GerritCommitMapping = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("mapped"), change: GerritChangeRevision }),
  Schema.Struct({ kind: Schema.Literal("new-candidate"), key: GerritChangeKey }),
  Schema.Struct({
    kind: Schema.Literal("ambiguous"),
    key: GerritChangeKey,
    candidates: Schema.Array(GerritChangeRevision),
    reason: Schema.Literals(["multiple-visible-matches", "partial-visible-results"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("invalid"),
    problems: Schema.NonEmptyArray(IdentityProblem),
  }),
]);
export type GerritCommitMapping = typeof GerritCommitMapping.Type;

export const GerritAccount = Schema.Struct({
  _account_id: Schema.optionalKey(PositiveInt),
  name: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
  display_name: Schema.optionalKey(Schema.String),
  /** Gerrit marks bot accounts, for example `SERVICE_USER`, so their notices can stay quiet. */
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});
export const GerritSelfAccount = Schema.Struct({
  ...GerritAccount.fields,
  _account_id: PositiveInt,
});
export const GerritGitPerson = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  date: Schema.String,
  tz: Schema.Int,
});
export const GerritReadRevision = Schema.Struct({
  commit: GitCommitOid,
  patchSet: GerritPatchSetNumber,
  parents: Schema.Array(GitCommitOid),
  author: GerritGitPerson,
  committer: GerritGitPerson,
});
export const GerritReadChange = Schema.Struct({
  key: GerritChangeKey,
  number: GerritChangeNumber,
  subject: Schema.String,
  status: Schema.Literals(["NEW", "MERGED", "ABANDONED"]),
  workInProgress: Schema.Boolean,
  topic: Schema.optionalKey(Schema.String),
  owner: GerritAccount,
  currentRevision: GitCommitOid,
  currentPatchSet: GerritPatchSetNumber,
  revisions: Schema.NonEmptyArray(GerritReadRevision),
});
export type GerritReadChange = typeof GerritReadChange.Type;

export const GerritRelatedRevision = Schema.Struct({
  installation: GerritInstallationId,
  project: GerritProjectName,
  commit: GitCommitOid,
  parents: Schema.Array(GitCommitOid),
  author: GerritGitPerson,
  committer: Schema.optionalKey(GerritGitPerson),
  subject: Schema.String,
  changeId: Schema.optionalKey(GerritChangeId),
  number: Schema.optionalKey(GerritChangeNumber),
  patchSet: Schema.optionalKey(GerritPatchSetNumber),
  currentPatchSet: Schema.optionalKey(GerritPatchSetNumber),
  status: Schema.optionalKey(GerritReadChange.fields.status),
  workInProgress: Schema.optionalKey(Schema.Boolean),
});

export const GerritConnectionConfig = Schema.Struct({
  installation: GerritInstallationId,
  authMode: Schema.Literal("http-basic"),
  /**
   * SSH clone host for this installation, for checkouts whose git operations go over SSH. An SSH
   * remote names only a clone host, so without this the checkout binds to no installation and its
   * change is never linked. Optional: HTTPS checkouts need nothing here.
   */
  sshHost: Schema.optionalKey(
    Schema.Struct({
      host: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
      port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
      username: Schema.optionalKey(
        Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/)),
      ),
    }),
  ),
  checksProfile: Schema.optionalKey(Schema.Literal("checks-rest-v1-3.10")),
  bindings: Schema.Array(
    Schema.Struct({
      url: Schema.String.check(
        Schema.isNonEmpty(),
        Schema.isMaxLength(4096),
        Schema.makeFilter((value) => {
          const url = URL.parse(value);
          return (
            Array.from(value).every((c) => c > " " && c !== "\u007f") &&
            !value.includes("?") &&
            !value.includes("#") &&
            (url === null ||
              (url.password === "" &&
                ((url.protocol !== "http:" && url.protocol !== "https:") || url.username === "")))
          );
        }),
      ),
      project: GerritProjectName,
    }),
  ),
});
export type GerritConnectionConfig = typeof GerritConnectionConfig.Type;

export class GerritReadError extends Schema.TaggedError<GerritReadError>()("GerritReadError", {
  reason: Schema.Literals([
    "invalid-input",
    "authentication",
    "forbidden",
    "not-found-or-hidden",
    "rate-limit",
    "redirect",
    "http",
    "offline",
    "timeout",
    "oversize",
    "invalid-response",
    "identity-mismatch",
  ]),
  status: Schema.optionalKey(Schema.Int),
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
}) {
  override get message(): string {
    return this.detail ?? `Gerrit read failed (${this.reason}).`;
  }
}

export class GerritConnectionError extends Schema.TaggedError<GerritConnectionError>()(
  "GerritConnectionError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "unsupported-auth",
      "not-configured",
      "credentials-missing",
      "credentials-invalid",
      "secret-store",
      "settings",
      "local-read",
      "persistence",
      "context-changed",
    ]),
  },
) {
  override get message(): string {
    return `Gerrit connection failed (${this.reason}).`;
  }
}

const Priority = Schema.Literals(["BATCH", "INTERACTIVE"]);
export const GerritCapabilities = Schema.StructWithRest(
  Schema.Struct({ priority: Schema.optionalKey(Priority) }),
  [
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.Boolean, Schema.Struct({ min: Schema.Int, max: Schema.Int }), Priority]),
    ),
  ],
).check(
  Schema.makeFilter((values) =>
    Object.entries(values).every(
      ([name, value]) => name === "priority" || typeof value !== "string",
    ),
  ),
);
export const GerritVerification = Schema.Struct({
  installation: GerritInstallationId,
  account: GerritSelfAccount,
  version: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("observed"), value: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("unknown"), error: GerritReadError }),
  ]),
  capabilities: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("observed"), values: GerritCapabilities }),
    Schema.Struct({ kind: Schema.Literal("unknown"), error: GerritReadError }),
  ]),
  observedAt: Schema.String,
  compatibility: Schema.Literal("unverified"),
});
export type GerritVerification = typeof GerritVerification.Type;

export const GerritChangeList = Schema.Struct({
  changes: Schema.Array(GerritReadChange),
  observation: GerritVisibleChanges,
  issue: Schema.optionalKey(
    Schema.Union([GerritReadError, Schema.Literals(["page-limit", "duplicate-results"])]),
  ),
});
export type GerritChangeList = typeof GerritChangeList.Type;
export const GerritRelatedChanges = Schema.Struct({
  anchor: Schema.optionalKey(GerritReadChange),
  revisions: Schema.Array(GerritRelatedRevision),
  completeness: Schema.Literals(["complete-visible", "partial"]),
  observedAt: Schema.String,
});
export type GerritRelatedChanges = typeof GerritRelatedChanges.Type;
export const GerritConnection = Schema.Struct({
  config: GerritConnectionConfig,
  credentialPresent: Schema.Boolean,
  verification: Schema.Literal("not-tested"),
});
export type GerritConnection = typeof GerritConnection.Type;
export const GerritInstallationInput = Schema.Struct({ installation: GerritInstallationId });
/** The saved GPG key passphrase is write-only; clients only learn whether one exists. */
export const GerritSigningPassphraseStatus = Schema.Struct({ present: Schema.Boolean });
export type GerritSigningPassphraseStatus = typeof GerritSigningPassphraseStatus.Type;
export const GerritSetSigningPassphraseInput = Schema.Struct({
  // null clears the saved passphrase. GPG reads it as one line, so line breaks are rejected.
  passphrase: Schema.NullOr(
    Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(4096),
      Schema.makeFilter((value: string) => !/[\r\n\0]/.test(value)),
    ),
  ),
});
export type GerritSetSigningPassphraseInput = typeof GerritSetSigningPassphraseInput.Type;
// Values are literals, never raw Gerrit query fragments. A leading ^ activates regex matching.
const GerritSearchTerm = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) =>
      value === value.trim() && !value.startsWith("^") && !/[\u0000-\u001f\u007f]/.test(value),
  ),
);
export const GerritChangesSearchInput = Schema.Struct({
  installation: GerritInstallationId,
  status: Schema.Literals(["open", "merged", "abandoned"]),
  project: Schema.optionalKey(GerritSearchTerm),
  branch: Schema.optionalKey(GerritSearchTerm),
  owner: Schema.optionalKey(GerritSearchTerm),
  topic: Schema.optionalKey(GerritSearchTerm),
  search: Schema.optionalKey(GerritSearchTerm),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10000 })),
});
export type GerritChangesSearchInput = typeof GerritChangesSearchInput.Type;
export const GerritChangesSearchResult = Schema.Struct({
  changes: Schema.Array(
    Schema.Struct({
      installation: GerritInstallationId,
      project: GerritProjectName,
      branch: GerritTargetBranch,
      changeId: GerritChangeId,
      number: GerritChangeNumber,
      subject: Schema.String,
      status: GerritReadChange.fields.status,
      owner: GerritAccount,
      topic: Schema.optionalKey(Schema.String),
      updated: Schema.String,
      workInProgress: Schema.Boolean,
    }),
  ),
  nextOffset: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10000 }))),
  completeness: Schema.Literals(["complete", "more", "truncated"]),
});
export type GerritChangesSearchResult = typeof GerritChangesSearchResult.Type;
export const GerritDeliveryCheckoutInput = Schema.Struct({
  cwd: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  /** Explicit destination when the remote binding has no target branch. */
  targetBranch: Schema.optionalKey(GerritTargetBranch),
});
export const GerritDeliveryFile = Schema.Struct({
  path: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  /** Porcelain v1 status field, for example ` M`, `A `, ` D`, or `??`. */
  status: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2)),
  untracked: Schema.Boolean,
  unmerged: Schema.Boolean,
});
export type GerritDeliveryFile = typeof GerritDeliveryFile.Type;
export const GerritDeliveryCheckout = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("new-change"),
    key: GerritChangeKey,
    localBranch: Schema.String,
    head: GitCommitOid,
    subject: Schema.String,
    files: Schema.Array(GerritDeliveryFile).check(Schema.isMaxLength(2000)),
  }),
  Schema.Struct({ kind: Schema.Literal("not-bound"), detail: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("blocked"), detail: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("ready"),
    /** The change is resolved from the checkout's remote and the HEAD Change-Id trailer. */
    change: GerritChangeRevision,
    localBranch: Schema.String,
    head: GitCommitOid,
    subject: Schema.String,
    topic: Schema.NullOr(Schema.String),
    workInProgress: Schema.Boolean,
    files: Schema.Array(GerritDeliveryFile).check(Schema.isMaxLength(2000)),
  }),
]);
export type GerritDeliveryCheckout = typeof GerritDeliveryCheckout.Type;
export const GerritConfigureInput = Schema.Struct({
  config: GerritConnectionConfig,
  credentials: Schema.optionalKey(Schema.Unknown),
});
