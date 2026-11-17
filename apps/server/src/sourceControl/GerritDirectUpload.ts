import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { commitIdentity } from "@t3tools/source-control-gerrit/server/localCommitMapping";
import { GerritRemoteTargetBranch } from "@t3tools/source-control-gerrit/server/remoteBinding";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { gitHttpAuthEnv } from "../vcs/VcsProcess.ts";
import * as GitHttpAuth from "../vcs/GitHttpAuth.ts";
import { preparePushSigning } from "./GerritPushSigning.ts";

type UploadOptions = {
  readonly cwd: string;
  readonly remote?: string;
  readonly commit?: string;
  readonly topic?: string;
  readonly reviewers?: ReadonlyArray<string>;
  readonly cc?: ReadonlyArray<string>;
  readonly wip?: boolean;
  readonly private?: boolean;
};
export type GerritDirectUploadInput = UploadOptions &
  (
    | { readonly kind: "new"; readonly branch: string }
    | {
        readonly kind: "patch-set";
        readonly change: {
          readonly number: number;
          readonly branch: string;
          readonly changeId: string;
        };
      }
  );
export type GerritDirectUploadResult = {
  readonly pushed: true;
  readonly changeNumber?: number;
  readonly url?: string;
  readonly patchSet?: number;
};

export class GerritDirectUploadError extends Schema.TaggedError<GerritDirectUploadError>()(
  "GerritDirectUploadError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "commit",
      "change-id",
      "change-id-mismatch",
      "credentials",
      "signing",
      "commit-signing",
      "fetch",
      "push",
      "no-new-changes",
    ]),
    cause: Schema.optional(Schema.Defect()),
    /** Gerrit's own rejection lines, so the agent can fix the upload instead of guessing. */
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "change-id":
        return "The commit must contain exactly one valid Change-Id footer. Install the Gerrit commit-msg hook and create or amend the commit before uploading.";
      case "change-id-mismatch":
        return "The commit Change-Id does not match the target change. Use the target Change-Id and the Gerrit commit-msg hook before uploading.";
      case "no-new-changes":
        return "Gerrit rejected the upload: no new changes.";
      case "invalid-input":
        return "Invalid Gerrit upload input.";
      case "commit":
        return "Could not read the commit to upload.";
      case "credentials":
        return "Could not read the saved signing passphrase.";
      case "signing":
        return "Could not prepare Gerrit push signing.";
      case "commit-signing":
        return "Could not sign the amended commit. No upload was attempted.";
      case "fetch":
        return this.detail
          ? `Could not fetch from Gerrit: ${this.detail}`
          : "Could not fetch and verify from Gerrit.";
      case "push":
        if (this.detail === undefined) return "Gerrit upload failed.";
        // A base the agent never fetched is the usual cause, and the agent cannot git fetch.
        return /no common ancestry/i.test(this.detail)
          ? `Gerrit rejected the upload: ${this.detail}. The commit is not based on the target branch: fetch it with fetch_gerrit_branch, rebase onto <remote>/<branch>, then upload again.`
          : `Gerrit rejected the upload: ${this.detail}`;
    }
  }
}

export class GerritDirectUpload extends Context.Service<
  GerritDirectUpload,
  {
    readonly upload: (
      input: GerritDirectUploadInput,
    ) => Effect.Effect<GerritDirectUploadResult, GerritDirectUploadError>;
    readonly amendSigned: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GerritDirectUploadError>;
    readonly fetchPatchSet: (input: {
      readonly cwd: string;
      readonly remote: string;
      readonly number: number;
      readonly patchSet: number;
      readonly commit: string;
    }) => Effect.Effect<string, GerritDirectUploadError>;
    readonly fetchBranch: (input: {
      readonly cwd: string;
      readonly remote: string;
      readonly branch: string;
    }) => Effect.Effect<{ readonly ref: string; readonly commit: string }, GerritDirectUploadError>;
  }
>()("t3/sourceControl/GerritDirectUpload") {}

const isTargetBranch = Schema.is(GerritRemoteTargetBranch);

// Git prints the remote URL in failures, and a remote URL can carry a password.
export function pushRejection(output: string): string | undefined {
  const lines = output
    .split("\n")
    .map((line) => line.replace(/:\/\/[^@/\s]+@/g, "://").trim())
    .filter(
      (line) =>
        /^(?:remote:\s*\S|!|error:|fatal:)/.test(line) &&
        !/^remote:\s*Processing changes/i.test(line),
    )
    .map((line) => line.replace(/^remote:\s*/, ""));
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  return text.length === 0 ? undefined : text.slice(0, 600);
}
const NON_INTERACTIVE_GIT_ENV = {
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} as const;

const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpAuth = yield* Effect.serviceOption(GitHttpAuth.GitHttpAuth);
  const upload = Effect.fn("GerritDirectUpload.upload")(function* (input: GerritDirectUploadInput) {
    const branch = input.kind === "new" ? input.branch : input.change.branch;
    const values = [input.topic, ...(input.reviewers ?? []), ...(input.cc ?? [])].filter(
      (v): v is string => v !== undefined,
    );
    if (
      !isTargetBranch(branch) ||
      values.some(
        (v) =>
          v.length === 0 ||
          Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
      ) ||
      (input.kind === "patch-set" &&
        (!Number.isSafeInteger(input.change.number) || input.change.number <= 0))
    ) {
      return yield* new GerritDirectUploadError({ reason: "invalid-input" });
    }
    // Runs isolated from the server's environment, so it adds its own prompt guards and credentials.
    const baseEnv = { ...process.env, ...NON_INTERACTIVE_GIT_ENV };
    const env = { ...baseEnv, ...(yield* gitHttpAuthEnv(baseEnv, platform, httpAuth)) };
    const run = Effect.fn("GerritDirectUpload.git")(function* (args: ReadonlyArray<string>) {
      return yield* host.process
        .run({
          operation: "GerritDirectUpload.git",
          command: "git",
          cwd: input.cwd,
          args,
          env,
          extendEnv: false,
          allowNonZeroExit: true,
          timeoutMs: 60_000,
          maxOutputBytes: 1024 * 1024,
        })
        .pipe(Effect.mapError((cause) => new GerritDirectUploadError({ reason: "commit", cause })));
    });
    const resolved = yield* run([
      "--no-replace-objects",
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${input.commit ?? "HEAD"}^{commit}`,
    ]);
    const oid = resolved.stdout.trim();
    if (
      resolved.exitCode !== 0 ||
      resolved.stdoutTruncated ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)
    )
      return yield* new GerritDirectUploadError({ reason: "commit" });
    const object = yield* run(["--no-replace-objects", "cat-file", "commit", oid]);
    const separator = object.stdout.indexOf("\n\n");
    if (object.exitCode !== 0 || object.stdoutTruncated || separator < 0)
      return yield* new GerritDirectUploadError({ reason: "commit" });
    const identity = commitIdentity(object.stdout.slice(separator + 2));
    if (identity.kind !== "valid")
      return yield* new GerritDirectUploadError({ reason: "change-id" });
    if (input.kind === "patch-set" && identity.changeId !== input.change.changeId)
      return yield* new GerritDirectUploadError({ reason: "change-id-mismatch" });
    const remote = yield* run(["remote", "get-url", "--push", "--all", input.remote ?? "origin"]);
    const destinations = remote.stdout.trim().split("\n").filter(Boolean);
    if (remote.exitCode !== 0 || remote.stdoutTruncated || destinations.length !== 1)
      return yield* new GerritDirectUploadError({ reason: "invalid-input" });
    const destination = destinations[0]!;
    const passphrase = yield* secrets
      .get("gerrit-gpg-signing-passphrase")
      .pipe(
        Effect.mapError((cause) => new GerritDirectUploadError({ reason: "credentials", cause })),
      );
    const options = ["no-publish-comments"];
    if (input.topic !== undefined) options.push(`topic=${encodeURIComponent(input.topic)}`);
    for (const reviewer of input.reviewers ?? []) options.push(`r=${encodeURIComponent(reviewer)}`);
    for (const account of input.cc ?? []) options.push(`cc=${encodeURIComponent(account)}`);
    if (input.wip) options.push("wip");
    if (input.private) options.push("private");
    const output = yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-gerrit-sign-" })
          .pipe(
            Effect.mapError((cause) => new GerritDirectUploadError({ reason: "signing", cause })),
          );
        const signing = yield* preparePushSigning({
          cwd: input.cwd,
          directory,
          env,
          ...(Option.isSome(passphrase)
            ? { passphrase: Redacted.make(new TextDecoder().decode(passphrase.value)) }
            : {}),
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(SourceControlHost.SourceControlHost, host),
              Layer.succeed(FileSystem.FileSystem, fs),
            ),
          ),
          Effect.mapError((cause) => new GerritDirectUploadError({ reason: "signing", cause })),
        );
        return yield* host.process
          .run({
            operation: "GerritDirectUpload.push",
            command: "git",
            cwd: input.cwd,
            args: [
              "--no-replace-objects",
              ...signing.args,
              "-c",
              "push.followTags=false",
              "push",
              "--porcelain",
              "--no-verify",
              "--no-follow-tags",
              "--signed=if-asked",
              "--recurse-submodules=no",
              "--",
              destination,
              `${oid}:refs/for/${branch}%${options.join(",")}`,
            ],
            env: { ...env, ...signing.env },
            extendEnv: false,
            allowNonZeroExit: true,
            timeoutMs: 60_000,
            maxOutputBytes: 1024 * 1024,
          })
          .pipe(Effect.mapError((cause) => new GerritDirectUploadError({ reason: "push", cause })));
      }),
    );
    if (output.exitCode !== 0) {
      const detail = pushRejection(`${output.stderr}\n${output.stdout}`);
      return yield* new GerritDirectUploadError({
        reason: /no new changes/i.test(`${output.stdout}\n${output.stderr}`)
          ? "no-new-changes"
          : "push",
        ...(detail === undefined ? {} : { detail }),
      });
    }
    const match = /https?:\/\/[^\s<>/]+\/(?:[^\s<>]*?\/\+\/)?(\d+)(?:\/(\d+))?(?=[\s<>]|$)/.exec(
      `${output.stderr}\n${output.stdout}`,
    );
    const number = match?.[1] === undefined ? undefined : Number(match[1]);
    const patchSet = match?.[2] === undefined ? undefined : Number(match[2]);
    return {
      pushed: true as const,
      ...(number !== undefined && Number.isSafeInteger(number)
        ? { changeNumber: number, url: match![0] }
        : {}),
      ...(patchSet !== undefined && Number.isSafeInteger(patchSet) ? { patchSet } : {}),
    };
  });
  const amendSigned = Effect.fn("GerritDirectUpload.amendSigned")(function* (input: {
    readonly cwd: string;
  }) {
    const passphrase = yield* secrets
      .get("gerrit-gpg-signing-passphrase")
      .pipe(
        Effect.mapError((cause) => new GerritDirectUploadError({ reason: "credentials", cause })),
      );
    const env = { ...process.env, ...NON_INTERACTIVE_GIT_ENV };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-gerrit-commit-sign-" })
          .pipe(
            Effect.mapError(
              (cause) => new GerritDirectUploadError({ reason: "commit-signing", cause }),
            ),
          );
        const signing = yield* preparePushSigning({
          cwd: input.cwd,
          directory,
          env,
          ...(Option.isSome(passphrase)
            ? { passphrase: Redacted.make(new TextDecoder().decode(passphrase.value)) }
            : {}),
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(SourceControlHost.SourceControlHost, host),
              Layer.succeed(FileSystem.FileSystem, fs),
            ),
          ),
          Effect.mapError(
            (cause) => new GerritDirectUploadError({ reason: "commit-signing", cause }),
          ),
        );
        const result = yield* host.process
          .run({
            operation: "GerritDirectUpload.amendSigned",
            command: "git",
            cwd: input.cwd,
            args: ["--no-replace-objects", ...signing.args, "commit", "--amend", "--no-edit", "-S"],
            env: { ...env, ...signing.env },
            extendEnv: false,
            allowNonZeroExit: true,
            timeoutMs: 60_000,
            maxOutputBytes: 1024 * 1024,
          })
          .pipe(
            Effect.mapError(
              (cause) => new GerritDirectUploadError({ reason: "commit-signing", cause }),
            ),
          );
        if (result.exitCode !== 0)
          return yield* new GerritDirectUploadError({ reason: "commit-signing" });
      }),
    );
  });
  const fetchPatchSet = Effect.fn("GerritDirectUpload.fetchPatchSet")(function* (input: {
    readonly cwd: string;
    readonly remote: string;
    readonly number: number;
    readonly patchSet: number;
    readonly commit: string;
  }) {
    if (
      !Number.isSafeInteger(input.number) ||
      input.number <= 0 ||
      !Number.isSafeInteger(input.patchSet) ||
      input.patchSet <= 0 ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit)
    )
      return yield* new GerritDirectUploadError({ reason: "fetch" });
    const baseEnv = { ...process.env, ...NON_INTERACTIVE_GIT_ENV };
    const env = { ...baseEnv, ...(yield* gitHttpAuthEnv(baseEnv, platform, httpAuth)) };
    const ref = `refs/t3/gerrit/${input.number}/${input.patchSet}`;
    const remoteRef = `refs/changes/${String(input.number % 100).padStart(2, "0")}/${input.number}/${input.patchSet}`;
    const run = (args: string[]) =>
      host.process
        .run({
          operation: "GerritDirectUpload.fetchPatchSet",
          command: "git",
          cwd: input.cwd,
          args,
          env,
          extendEnv: false,
          allowNonZeroExit: true,
          timeoutMs: 60_000,
          maxOutputBytes: 1024 * 1024,
        })
        .pipe(Effect.mapError((cause) => new GerritDirectUploadError({ reason: "fetch", cause })));
    const fetched = yield* run([
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--",
      input.remote,
      remoteRef,
    ]);
    if (fetched.exitCode !== 0) return yield* new GerritDirectUploadError({ reason: "fetch" });
    const resolved = yield* run([
      "--no-replace-objects",
      "rev-parse",
      "--verify",
      "FETCH_HEAD^{commit}",
    ]);
    if (
      resolved.exitCode !== 0 ||
      resolved.stdoutTruncated ||
      resolved.stdout.trim() !== input.commit
    )
      return yield* new GerritDirectUploadError({ reason: "fetch" });
    const updated = yield* run(["update-ref", ref, input.commit]);
    if (updated.exitCode !== 0) return yield* new GerritDirectUploadError({ reason: "fetch" });
    return ref;
  });
  // Agents' own git has no Gerrit login, so the base they rebase onto is fetched with T3's.
  const fetchBranch = Effect.fn("GerritDirectUpload.fetchBranch")(function* (input: {
    readonly cwd: string;
    readonly remote: string;
    readonly branch: string;
  }) {
    if (!isTargetBranch(input.branch) || !/^[A-Za-z0-9._-]+$/.test(input.remote))
      return yield* new GerritDirectUploadError({ reason: "invalid-input" });
    const baseEnv = { ...process.env, ...NON_INTERACTIVE_GIT_ENV };
    const env = { ...baseEnv, ...(yield* gitHttpAuthEnv(baseEnv, platform, httpAuth)) };
    const ref = `refs/remotes/${input.remote}/${input.branch}`;
    const run = (args: string[]) =>
      host.process
        .run({
          operation: "GerritDirectUpload.fetchBranch",
          command: "git",
          cwd: input.cwd,
          args,
          env,
          extendEnv: false,
          allowNonZeroExit: true,
          timeoutMs: 120_000,
          maxOutputBytes: 1024 * 1024,
        })
        .pipe(Effect.mapError((cause) => new GerritDirectUploadError({ reason: "fetch", cause })));
    const fetched = yield* run([
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--",
      input.remote,
      `+refs/heads/${input.branch}:${ref}`,
    ]);
    if (fetched.exitCode !== 0) {
      const detail = pushRejection(`${fetched.stderr}\n${fetched.stdout}`);
      return yield* new GerritDirectUploadError({
        reason: "fetch",
        ...(detail === undefined ? {} : { detail }),
      });
    }
    const resolved = yield* run([
      "--no-replace-objects",
      "rev-parse",
      "--verify",
      `${ref}^{commit}`,
    ]);
    const commit = resolved.stdout.trim();
    if (resolved.exitCode !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
      return yield* new GerritDirectUploadError({ reason: "fetch" });
    return { ref, commit };
  });
  return GerritDirectUpload.of({ upload, amendSigned, fetchPatchSet, fetchBranch });
});

export const layer = Layer.effect(GerritDirectUpload, make);
