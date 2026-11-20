import {
  GerritChangeNumber,
  GerritInstallationId,
  type GerritReadError,
  type GerritWriteError,
  type GerritDirectAction,
  type GerritDirectTarget,
  type GerritDirectUploadInput,
  type GerritDirectComment,
} from "@t3tools/contracts";
import { makeDirectActions } from "@t3tools/source-control-gerrit/server/GerritDirectActions";
import * as GerritHttp from "@t3tools/source-control-gerrit/server/GerritHttp";
import * as GerritRemotes from "@t3tools/source-control-gerrit/server/GerritRemotes";
import { gerritRemoteConfiguration } from "@t3tools/source-control-gerrit/server/remoteBinding";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerSettings from "../serverSettings.ts";
import * as GerritTarget from "./GerritTarget.ts";
import * as GerritWatchCompletion from "./GerritWatchCompletion.ts";
import * as GerritDirectUpload from "./GerritDirectUpload.ts";

export class GerritDirectError extends Schema.TaggedError<GerritDirectError>()(
  "GerritDirectError",
  {
    reason: Schema.Literals(["target", "credentials", "action", "upload", "closed"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "closed"
      ? "The Gerrit change is merged or abandoned; its review is closed."
      : `Gerrit ${this.reason} failed.`;
  }
}

// Gerrit accepts comments and post-submit votes on closed changes, but T3 treats the review of a
// merged or abandoned change as over, matching the pull request panel.
const REVIEW_ACTIONS = new Set([
  "review",
  "reply",
  "resolve",
  "draft",
  "delete-draft",
  "add-reviewer",
  "remove-reviewer",
]);

const decodeInstallation = Schema.decodeUnknownEffect(GerritInstallationId);
const decodeNumber = Schema.decodeUnknownEffect(GerritChangeNumber);
const isDirectError = Schema.is(GerritDirectError);

type Notify = "NONE" | "OWNER" | "OWNER_REVIEWERS" | "ALL";
type ActInput = {
  readonly cwd: string;
  readonly target: GerritDirectTarget;
  readonly action: GerritDirectAction;
  readonly revision?: string;
  readonly notify?: Notify;
};
type Change = Effect.Success<ReturnType<GerritHttp.GerritHttp["Service"]["getChangeByNumber"]>>;
type ActResult = void | string | { readonly number: number; readonly url: string };
type Response<T> = {
  readonly result: T;
  readonly change: Change | null;
  readonly rereadError?: string;
};
export class GerritDirectService extends Context.Service<
  GerritDirectService,
  {
    readonly act: (input: ActInput) => Effect.Effect<Response<ActResult>, GerritDirectError>;
    readonly amendSigned: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GerritDirectError>;
    readonly fetchPatchSet: (input: {
      readonly cwd: string;
      readonly target: GerritDirectTarget;
    }) => Effect.Effect<
      { readonly ref: string; readonly commit: string; readonly patchSet: number },
      GerritDirectError
    >;
    readonly fetchBranch: (input: {
      readonly cwd: string;
      readonly branch: string;
    }) => Effect.Effect<{ readonly ref: string; readonly commit: string }, GerritDirectError>;
    readonly upload: (input: {
      readonly cwd: string;
      readonly upload: GerritDirectUploadInput;
    }) => Effect.Effect<Response<GerritDirectUpload.GerritDirectUploadResult>, GerritDirectError>;
  }
>()("t3/sourceControl/GerritDirectService") {}

const comment = (c: GerritDirectComment) => {
  const { range, ...rest } = c;
  return {
    ...rest,
    ...(range === undefined
      ? {}
      : {
          range: {
            start_line: range.startLine,
            start_character: range.startCharacter,
            end_line: range.endLine,
            end_character: range.endCharacter,
          },
        }),
  };
};
const make = Effect.gen(function* () {
  const target = yield* GerritTarget.GerritTarget;
  const uploader = yield* GerritDirectUpload.GerritDirectUpload;
  const http = yield* GerritHttp.GerritHttp;
  const remotes = yield* GerritRemotes.GerritRemotes;
  const settings = yield* ServerSettings.ServerSettingsService;
  const actions = makeDirectActions(http.directWrite, http.getChangeByNumber);
  const resolve = Effect.fn("GerritDirectService.resolve")(function* (
    input: GerritTarget.TargetInput,
  ) {
    return yield* target.resolve(input).pipe(
      Effect.mapError(
        (cause) =>
          new GerritDirectError({
            reason: cause.reason === "credential-unavailable" ? "credentials" : "target",
            cause,
          }),
      ),
    );
  });
  const authFor = Effect.fn("GerritDirectService.auth")(function* (server: string) {
    const installation = yield* decodeInstallation(server).pipe(
      Effect.mapError((cause) => new GerritDirectError({ reason: "target", cause })),
    );
    const credentials = yield* target
      .credentials(server)
      .pipe(Effect.mapError((cause) => new GerritDirectError({ reason: "credentials", cause })));
    return { installation, credentials };
  });
  const act = Effect.fn("GerritDirectService.act")(function* (input: ActInput) {
    const resolved = yield* resolve({ cwd: input.cwd, ...input.target });
    const auth = yield* authFor(resolved.server);
    if (resolved.number === undefined) return yield* new GerritDirectError({ reason: "target" });
    const number = yield* decodeNumber(resolved.number).pipe(
      Effect.mapError((cause) => new GerritDirectError({ reason: "target", cause })),
    );
    const t = {
      number,
      project: resolved.project,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
    };
    const a = input.action;
    const notify = input.notify === undefined ? {} : { notify: input.notify };
    if (REVIEW_ACTIONS.has(a.kind)) {
      const current = yield* http
        .getChangeByNumber({ ...auth, number })
        .pipe(Effect.mapError((cause) => new GerritDirectError({ reason: "action", cause })));
      if (current.status !== "NEW") return yield* new GerritDirectError({ reason: "closed" });
    }
    let detail: Effect.Success<ReturnType<typeof http.review.readReview>> | undefined;
    if (
      a.kind === "reply" ||
      a.kind === "resolve" ||
      (a.kind === "review" && (a.publishDrafts?.length ?? 0) > 0)
    ) {
      const change = yield* http
        .getChangeByNumber({ ...auth, number })
        .pipe(Effect.mapError((cause) => new GerritDirectError({ reason: "action", cause })));
      const revision =
        input.revision === undefined
          ? change.currentRevision
          : change.revisions.find(
              (r) => String(r.patchSet) === input.revision || r.commit === input.revision,
            )?.commit;
      if (revision === undefined) return yield* new GerritDirectError({ reason: "action" });
      detail = yield* http.review
        .readReview({ ...auth, key: change.key, number, revision })
        .pipe(Effect.mapError((cause) => new GerritDirectError({ reason: "action", cause })));
    }
    const run = ((): Effect.Effect<
      ActResult,
      GerritDirectError | GerritReadError | GerritWriteError
    > => {
      switch (a.kind) {
        case "review": {
          const drafts = (a.publishDrafts ?? []).map((id) =>
            detail?.drafts.find((d) => d.id === id),
          );
          if (drafts.some((d) => d === undefined || d.message === null || d.unresolved === null))
            return Effect.fail(new GerritDirectError({ reason: "action" }));
          return actions.review(auth, t, {
            ...notify,
            ...(a.message === undefined ? {} : { message: a.message }),
            ...(a.labels === undefined ? {} : { labels: a.labels }),
            comments: (a.comments ?? []).map(comment),
            drafts: drafts.map((d) => ({
              ...d!.anchor,
              id: d!.id,
              message: d!.message!,
              unresolved: d!.unresolved!,
              ...(d!.inReplyTo === null ? {} : { inReplyTo: d!.inReplyTo }),
            })),
          });
        }
        case "reply":
        case "resolve": {
          const c = detail?.comments.find((c) => c.id === a.commentId);
          if (!c) return Effect.fail(new GerritDirectError({ reason: "action" }));
          const anchor = { ...c.anchor, inReplyTo: c.id };
          return a.kind === "reply"
            ? actions.reply(auth, t, {
                comment: {
                  ...anchor,
                  message: a.message,
                  ...(a.unresolved === undefined ? {} : { unresolved: a.unresolved }),
                },
                ...notify,
              })
            : actions.resolve(auth, t, {
                comment: anchor,
                ...(a.message === undefined ? {} : { message: a.message }),
                ...notify,
              });
        }
        case "draft":
          return actions.saveDraft(auth, t, {
            comment: comment(a.comment),
            ...(a.id === undefined ? {} : { id: a.id }),
          });
        case "delete-draft":
          return actions.deleteDraft(auth, t, a.id);
        case "topic":
          return actions.setTopic(auth, t, a.topic);
        case "add-reviewer":
          return actions.addReviewer(auth, t, {
            reviewer: a.account,
            state: a.state ?? "REVIEWER",
            ...notify,
          });
        case "remove-reviewer":
          return actions.removeReviewer(auth, t, { reviewer: a.account, ...notify });
        case "wip":
          return actions.setWip(auth, t, a.value);
        case "private":
          return actions.setPrivate(auth, t, a.value, a.message);
        case "commit-message":
          return actions.setCommitMessage(auth, t, a.message);
        case "abandon":
          return actions.abandon(auth, t, {
            ...notify,
            ...(a.message === undefined ? {} : { message: a.message }),
          });
        case "restore":
          return actions.restore(auth, t, {
            ...notify,
            ...(a.message === undefined ? {} : { message: a.message }),
          });
        case "submit":
          return actions.submit(auth, t, notify);
        case "rebase":
          return actions.rebase(auth, t, a.base === undefined ? {} : { base: a.base });
        case "rebase-chain":
          return actions.rebaseChain(auth, t, a.base === undefined ? {} : { base: a.base });
        case "cherry-pick":
          return actions.cherryPick(auth, t, {
            destination: a.destination,
            ...(a.message === undefined ? {} : { message: a.message }),
            ...(a.topic === undefined ? {} : { topic: a.topic }),
          });
      }
    })();
    const nativeAction = yield* GerritWatchCompletion.NativeAction;
    const write =
      a.kind === "submit" || a.kind === "abandon"
        ? nativeAction(
            { server: resolved.server, project: resolved.project, number, operation: a.kind },
            run,
          )
        : run;
    const result = yield* write.pipe(
      Effect.mapError((cause) =>
        isDirectError(cause) ? cause : new GerritDirectError({ reason: "action", cause }),
      ),
    );
    return yield* http.getChangeByNumber({ ...auth, number }).pipe(
      Effect.map((change) => ({ result, change })),
      Effect.orElseSucceed(() => ({
        result,
        change: null,
        rereadError: "Could not re-read the change after the write.",
      })),
    );
  });
  const upload = Effect.fn("GerritDirectService.upload")(function* (input: {
    readonly cwd: string;
    readonly upload: GerritDirectUploadInput;
  }) {
    const checkout = yield* resolve({ cwd: input.cwd });
    const u = input.upload;
    const selected =
      u.kind === "patch-set"
        ? yield* resolve({
            cwd: input.cwd,
            ...("number" in u ? { number: u.number } : { url: u.url }),
          })
        : checkout;
    const auth = yield* authFor(selected.server);
    const config = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new GerritDirectError({ reason: "target", cause })),
    );
    const discovery = yield* remotes
      .discover({
        cwd: input.cwd,
        configuration: gerritRemoteConfiguration(Object.values(config.gerritConnections)),
      })
      .pipe(Effect.mapError((cause) => new GerritDirectError({ reason: "target", cause })));
    const matches = discovery.remotes.filter(
      (r) =>
        r.effective.push.length === 1 &&
        r.effective.push[0]?.kind === "candidate" &&
        r.effective.push[0].repositories.length === 1 &&
        r.effective.push[0].repositories[0]?.installation === checkout.server &&
        r.effective.push[0].repositories[0]?.project === checkout.project,
    );
    if (matches.length !== 1) return yield* new GerritDirectError({ reason: "target" });
    let change: Change | undefined;
    if (u.kind === "patch-set") {
      const number = yield* decodeNumber(selected.number).pipe(
        Effect.mapError((cause) => new GerritDirectError({ reason: "target", cause })),
      );
      change = yield* http
        .getChangeByNumber({ ...auth, number })
        .pipe(Effect.mapError((cause) => new GerritDirectError({ reason: "target", cause })));
    }
    const options = {
      cwd: input.cwd,
      remote: matches[0]!.name,
      ...(u.commit === undefined ? {} : { commit: u.commit }),
      ...(u.topic === undefined ? {} : { topic: u.topic }),
      ...(u.reviewers === undefined ? {} : { reviewers: u.reviewers }),
      ...(u.cc === undefined ? {} : { cc: u.cc }),
      ...(u.wip === undefined ? {} : { wip: u.wip }),
      ...(u.private === undefined ? {} : { private: u.private }),
    };
    const result = yield* uploader
      .upload(
        u.kind === "new"
          ? { ...options, kind: "new", branch: u.branch }
          : {
              ...options,
              kind: "patch-set",
              change: {
                number: change!.number,
                branch: change!.key.branch,
                changeId: change!.key.changeId,
              },
            },
      )
      .pipe(Effect.mapError((cause) => new GerritDirectError({ reason: "upload", cause })));
    const number = result.changeNumber ?? change?.number;
    if (number === undefined) return { result, change: null };
    return yield* decodeNumber(number).pipe(
      Effect.flatMap((number) => http.getChangeByNumber({ ...auth, number })),
      Effect.map((change) => ({ result, change })),
      Effect.orElseSucceed(() => ({
        result,
        change: null,
        rereadError: "Could not re-read the change after the upload.",
      })),
    );
  });
  const fetchPatchSet = Effect.fn("GerritDirectService.fetchPatchSet")(function* (input: {
    readonly cwd: string;
    readonly target: GerritDirectTarget;
  }) {
    const selected = yield* resolve({ cwd: input.cwd, ...input.target });
    const auth = yield* authFor(selected.server);
    const number = yield* decodeNumber(selected.number).pipe(
      Effect.mapError((cause) => new GerritDirectError({ reason: "target", cause })),
    );
    const change = yield* http
      .getChangeByNumber({ ...auth, number })
      .pipe(Effect.mapError((cause) => new GerritDirectError({ reason: "target", cause })));
    const config = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new GerritDirectError({ reason: "target", cause })),
    );
    const discovery = yield* remotes
      .discover({
        cwd: input.cwd,
        configuration: gerritRemoteConfiguration(Object.values(config.gerritConnections)),
      })
      .pipe(Effect.mapError((cause) => new GerritDirectError({ reason: "target", cause })));
    const matches = discovery.remotes.filter(
      (r) =>
        r.effective.fetch.length === 1 &&
        r.effective.fetch[0]?.kind === "candidate" &&
        r.effective.fetch[0].repositories.length === 1 &&
        r.effective.fetch[0].repositories[0]?.installation === selected.server &&
        r.effective.fetch[0].repositories[0]?.project === selected.project,
    );
    if (matches.length !== 1 || change.currentRevision === null)
      return yield* new GerritDirectError({ reason: "target" });
    const ref = yield* uploader
      .fetchPatchSet({
        cwd: input.cwd,
        remote: matches[0]!.name,
        number: change.number,
        patchSet: change.currentPatchSet,
        commit: change.currentRevision,
      })
      .pipe(Effect.mapError((cause) => new GerritDirectError({ reason: "target", cause })));
    return { ref, commit: change.currentRevision, patchSet: change.currentPatchSet };
  });
  const fetchBranch = Effect.fn("GerritDirectService.fetchBranch")(function* (input: {
    readonly cwd: string;
    readonly branch: string;
  }) {
    const config = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new GerritDirectError({ reason: "target", cause })),
    );
    const discovery = yield* remotes
      .discover({
        cwd: input.cwd,
        configuration: gerritRemoteConfiguration(Object.values(config.gerritConnections)),
      })
      .pipe(Effect.mapError((cause) => new GerritDirectError({ reason: "target", cause })));
    const matches = discovery.remotes.filter(
      (r) =>
        r.effective.fetch.length === 1 &&
        r.effective.fetch[0]?.kind === "candidate" &&
        r.effective.fetch[0].repositories.length === 1,
    );
    if (matches.length !== 1) return yield* new GerritDirectError({ reason: "target" });
    return yield* uploader
      .fetchBranch({ cwd: input.cwd, remote: matches[0]!.name, branch: input.branch })
      .pipe(Effect.mapError((cause) => new GerritDirectError({ reason: "upload", cause })));
  });
  const amendSigned = Effect.fn("GerritDirectService.amendSigned")(function* (input: {
    readonly cwd: string;
  }) {
    yield* uploader
      .amendSigned(input)
      .pipe(Effect.mapError((cause) => new GerritDirectError({ reason: "upload", cause })));
  });
  return GerritDirectService.of({ act, upload, amendSigned, fetchPatchSet, fetchBranch });
});
export const layer = Layer.effect(GerritDirectService, make);
