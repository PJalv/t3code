import {
  GerritChangeId,
  GerritChangeNumber,
  GerritInstallationId,
  GerritProjectName,
  GerritPatchSetNumber,
  GerritTargetBranch,
  SourceControlProviderError,
  SourceControlProviderKind,
  type ChangeRequest,
} from "@t3tools/contracts";
import type { SourceControlProvider } from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GerritHttp from "./GerritHttp.ts";
import { commitIdentity } from "./localCommitMapping.ts";

// Gerrit serves authenticated repositories beneath the installation root.
const projectRemoteUrl = (input: { readonly installation: string; readonly project: string }) =>
  `${input.installation.replace(/\/+$/, "")}/a/${input.project}`;

const decodeNumber = Schema.decodeEffect(Schema.NumberFromString);
const decodeChangeNumber = Schema.decodeEffect(GerritChangeNumber);
const decodeNumberFromString = (value: string) =>
  decodeNumber(value).pipe(Effect.flatMap(decodeChangeNumber));
import type { GerritLocalCommits } from "./GerritLocalCommits.ts";

const kind = SourceControlProviderKind.make("gerrit");

export interface GerritBranchReviewScope {
  readonly installation: string;
  readonly project: string;
  readonly branch: string;
  readonly credentials: GerritHttp.GerritHttpCredentials;
}

export interface GerritBranchReviewsInput {
  readonly http: GerritHttp.GerritHttp["Service"];
  /**
   * Credentials and project binding for this working copy. `null` means the repository is not a
   * configured Gerrit checkout, which is a normal "no change here" answer rather than an error.
   */
  readonly resolve: (
    cwd: string,
  ) => Effect.Effect<
    (GerritBranchReviewScope & { readonly baseUrl: string }) | null,
    SourceControlProviderError
  >;
  /** Runs a read-only git command in the working copy. */
  readonly git: (
    cwd: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, SourceControlProviderError>;
  /**
   * The dispatcher that already owns every Gerrit write. Checkout is a git fetch of a patch-set
   * ref, so this only reports intent; it never pushes.
   */
  readonly localCommits: GerritLocalCommits["Service"];
}

const failure = (input: {
  readonly operation: string;
  readonly cwd: string;
  readonly detail: string;
  readonly cause?: unknown;
}) =>
  new SourceControlProviderError({
    provider: kind,
    operation: input.operation,
    cwd: input.cwd,
    detail: input.detail,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });

/** Gerrit reports status as upper-case words; the shared contract uses lower-case. */
const changeRequestState = (status: "NEW" | "MERGED" | "ABANDONED"): ChangeRequest["state"] =>
  status === "NEW" ? "open" : status === "MERGED" ? "merged" : "closed";

const toChangeRequest = (
  baseUrl: string,
  change: GerritHttp.ChangeList["changes"][number],
): ChangeRequest => {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return {
    provider: kind,
    number: change.number,
    title: change.subject,
    url: `${base}c/${change.key.project}/+/${String(change.number)}`,
    baseRefName: change.key.branch,
    headRefName: change.key.branch,
    headSha: change.currentRevision,
    state: changeRequestState(change.status),
    ...(change.workInProgress ? { isDraft: true } : {}),
    updatedAt: Option.none(),
    isCrossRepository: false,
    headRepositoryNameWithOwner: change.key.project,
    headRepositoryOwnerLogin: null,
  };
};

/**
 * Gerrit has no per-branch change request: a branch's change is the one named by its tip's
 * `Change-Id` trailer, read with the remote's current patch set for that Change-Id. Read-only.
 */
export const makeBranchReviews = (
  input: GerritBranchReviewsInput,
): Pick<
  SourceControlProvider["Service"],
  | "headBranchProbe"
  | "listChangeRequests"
  | "getChangeRequest"
  | "createChangeRequest"
  | "checkoutChangeRequest"
> => ({
  // Gerrit cannot search by head selector, so the selector is only a way to find the local
  // branch tip; the Change-Id comes from that tip's trailer.
  headBranchProbe: ({ headSelectors, state }) => ({
    headSelectors: headSelectors.slice(0, 1),
    limit: state === "open" ? 1 : 20,
  }),

  listChangeRequests: Effect.fn("GerritBranchReviews.listChangeRequests")(
    function* (request) {
      const scope = yield* input.resolve(request.cwd);
      if (scope === null) return [];

      // The tip for this branch, or nothing to look up. git prints a trailing newline, and that
      // newline must not reach the next command's argv: `git log <oid>\n` fails as an ambiguous
      // argument, which reads like a broken checkout rather than a malformed call.
      const tip = (yield* input
        .git(request.cwd, ["rev-parse", "--verify", `${request.headSelector}^{commit}`])
        .pipe(Effect.option)).pipe(Option.getOrNull, (value) => value?.trim() ?? null);
      if (tip === null || tip.length === 0) return [];

      const message = yield* input.git(request.cwd, ["log", "-1", "--format=%B", tip]);
      const identity = commitIdentity(message);
      if (identity.kind !== "valid") return [];

      const installation = GerritInstallationId.make(scope.installation);
      const project = GerritProjectName.make(scope.project);
      const branch = GerritTargetBranch.make(scope.branch);
      const changeId = GerritChangeId.make(identity.changeId);

      const listed = yield* input.http.listChanges({
        installation,
        credentials: scope.credentials,
        scope: { installation, project, branch },
        changeId,
      });

      const matches = listed.changes.filter(
        (change) =>
          change.key.changeId === changeId &&
          change.key.project === project &&
          change.key.branch === branch &&
          (request.state === "all" || changeRequestState(change.status) === request.state),
      );

      return matches
        .slice(0, request.limit ?? (request.state === "open" ? 1 : 20))
        .map((change) => toChangeRequest(scope.baseUrl, change));
    },
    (effect, request) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause._tag === "SourceControlProviderError"
            ? cause
            : failure({
                operation: "listChangeRequests",
                cwd: request.cwd,
                detail: "Gerrit could not list changes for this branch.",
                cause,
              }),
        ),
      ),
  ),

  getChangeRequest: Effect.fn("GerritBranchReviews.getChangeRequest")(function* (request) {
    const scope = yield* input.resolve(request.cwd);
    if (scope === null)
      return yield* failure({
        operation: "getChangeRequest",
        cwd: request.cwd,
        detail: "This repository is not a configured Gerrit checkout.",
      });
    const installation = GerritInstallationId.make(scope.installation);
    const project = GerritProjectName.make(scope.project);
    const branch = GerritTargetBranch.make(scope.branch);
    const reference = request.reference.trim();
    const number = /^#?(\d+)$/.exec(reference)?.[1];
    if (number === undefined)
      return yield* failure({
        operation: "getChangeRequest",
        cwd: request.cwd,
        detail: "Use a Gerrit change number, for example #62.",
      });
    const change = yield* input.http
      .getChangeByNumber({
        installation,
        credentials: scope.credentials,
        number: yield* decodeNumberFromString(number).pipe(
          Effect.mapError(() =>
            failure({
              operation: "getChangeRequest",
              cwd: request.cwd,
              detail: "Invalid change number.",
            }),
          ),
        ),
      })
      .pipe(
        Effect.mapError((cause) =>
          failure({
            operation: "getChangeRequest",
            cwd: request.cwd,
            detail: `Gerrit did not return change ${number} in ${project} on ${branch}.`,
            cause,
          }),
        ),
      );
    return yield* Effect.succeed(toChangeRequest(scope.baseUrl, change));
  }),

  /**
   * Gerrit creates a change by receiving a push to `refs/for/<branch>`; it is not an HTTP
   * operation. That write belongs to the existing upload dispatch path, behind the human
   * confirmation and write journal that already guard it, so this adapter does not offer a
   * second way to create one.
   */
  createChangeRequest: (request) =>
    failure({
      operation: "createChangeRequest",
      cwd: request.cwd,
      detail: "Gerrit changes are created by a confirmed push to refs/for/<branch>.",
    }),

  checkoutChangeRequest: Effect.fn("GerritBranchReviews.checkoutChangeRequest")(
    function* (request) {
      const scope = yield* input.resolve(request.cwd);
      if (scope === null)
        return yield* failure({
          operation: "checkoutChangeRequest",
          cwd: request.cwd,
          detail: "This repository is not a configured Gerrit checkout.",
        });
      const number = /^#?(\d+)$/.exec(request.reference.trim())?.[1];
      if (number === undefined)
        return yield* failure({
          operation: "checkoutChangeRequest",
          cwd: request.cwd,
          detail: "Use a Gerrit change number, for example #62.",
        });
      const installation = GerritInstallationId.make(scope.installation);
      // Gerrit's patch-set ref is derivable from the number and patch set alone:
      // refs/changes/<last two digits>/<number>/<patch set>.
      const change = yield* input.http
        .getChangeByNumber({
          installation,
          credentials: scope.credentials,
          number: yield* decodeNumberFromString(number).pipe(
            Effect.mapError(() =>
              failure({
                operation: "getChangeRequest",
                cwd: request.cwd,
                detail: "Invalid change number.",
              }),
            ),
          ),
        })
        .pipe(
          Effect.mapError((cause) =>
            failure({
              operation: "checkoutChangeRequest",
              cwd: request.cwd,
              detail: `Gerrit did not return change ${number}.`,
              cause,
            }),
          ),
        );
      const patchSet = GerritPatchSetNumber.make(change.currentPatchSet);
      yield* input
        .git(request.cwd, [
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          // Gerrit serves a project below the installation root, so the bare installation URL
          // fetches nothing. `projectRemoteUrl` adds the authenticated project path.
          projectRemoteUrl({ installation: scope.installation, project: scope.project }),
          `+refs/changes/${String(change.number % 100).padStart(2, "0")}/${String(change.number)}/${String(patchSet)}:refs/t3/gerrit/${String(change.number)}/${String(patchSet)}`,
        ])
        .pipe(
          Effect.mapError((cause) =>
            failure({
              operation: "checkoutChangeRequest",
              cwd: request.cwd,
              detail: `Gerrit patch set ${String(patchSet)} for change ${number} could not be fetched.`,
              cause,
            }),
          ),
        );
      yield* input
        .git(request.cwd, [
          "checkout",
          "--detach",
          `refs/t3/gerrit/${String(change.number)}/${String(patchSet)}`,
        ])
        .pipe(
          Effect.mapError((cause) =>
            failure({
              operation: "checkoutChangeRequest",
              cwd: request.cwd,
              detail: `Change ${number} was fetched but could not be checked out.`,
              cause,
            }),
          ),
        );
    },
  ),
});
