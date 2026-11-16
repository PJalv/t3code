import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { trustedPushGpg } from "./HostSignerCapability.ts";

export class GerritPushSigningError extends Schema.TaggedError<GerritPushSigningError>()(
  "GerritPushSigningError",
  { reason: Schema.Literals(["identity", "signer", "passphrase-rejected", "storage"]) },
) {
  override get message(): string {
    return this.reason === "passphrase-rejected"
      ? "The saved GPG key passphrase was rejected. No upload was attempted."
      : "Could not prepare GPG push signing. No upload was attempted.";
  }
}

/** Prepare the signer before recording dispatch intent: a local failure is safe to correct. */
export const preparePushSigning = Effect.fn("GerritPushSigning.prepare")(function* (input: {
  readonly cwd: string;
  readonly directory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly passphrase?: Redacted.Redacted<string>;
}) {
  const host = yield* SourceControlHost.SourceControlHost;
  const fs = yield* FileSystem.FileSystem;
  const local = Effect.fn("GerritPushSigning.identityConfig")(function* (args: string[]) {
    return yield* host.process
      .run({
        operation: "GerritPushSigning.identityConfig",
        command: "git",
        cwd: input.cwd,
        args: ["--no-lazy-fetch", "--no-replace-objects", ...args],
        extendEnv: false,
        env: {
          PATH: input.env.PATH,
          HOME: input.env.HOME,
          SYSTEMROOT: input.env.SYSTEMROOT,
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
        allowNonZeroExit: true,
        timeoutMs: 60_000,
        maxOutputBytes: 4096,
      })
      .pipe(Effect.mapError(() => new GerritPushSigningError({ reason: "identity" })));
  });
  const configured = yield* local(["config", "--get", "user.signingkey"]);
  const ident = yield* local(["var", "GIT_COMMITTER_IDENT"]);
  const identity =
    ident.exitCode === 0 && !ident.stdoutTruncated
      ? /^([^\n<>]+) <([^\n<>]+)> \d+ [+-]\d{4}\s*$/.exec(ident.stdout)
      : null;
  const key =
    configured.exitCode === 0 && !configured.stdoutTruncated
      ? configured.stdout.trim()
      : identity?.[2];
  const gpg = yield* Effect.tryPromise({
    try: () => trustedPushGpg(input.env.PATH ?? "", input.cwd),
    catch: () => new GerritPushSigningError({ reason: "signer" }),
  }).pipe(
    // Unsigned servers must still work on hosts without GPG. If the remote asks for a
    // certificate, this inert signer fails the push instead of running repository config.
    Effect.catch((error) =>
      input.passphrase === undefined ? Effect.succeed("/dev/null") : Effect.fail(error),
    ),
  );
  const env = {
    HOME: input.env.HOME,
    GNUPGHOME: input.env.GNUPGHOME,
    XDG_RUNTIME_DIR: input.env.XDG_RUNTIME_DIR,
  };
  if (input.passphrase !== undefined) {
    if (identity === null || key === undefined || key.length === 0)
      return yield* new GerritPushSigningError({ reason: "identity" });
    const signed = yield* host.process
      .run({
        operation: "GerritPushSigning.unlock",
        command: gpg,
        cwd: input.cwd,
        args: [
          "--batch",
          "--no-tty",
          "--pinentry-mode",
          "loopback",
          "--passphrase-fd",
          "0",
          "--status-fd",
          "2",
          "--armor",
          "--detach-sign",
          "--local-user",
          key,
        ],
        extendEnv: false,
        env: { ...env, PATH: input.env.PATH, LC_ALL: "C" },
        stdin: `${Redacted.value(input.passphrase)}\nT3 Code signing check\n`,
        allowNonZeroExit: true,
        timeoutMs: 60_000,
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(Effect.mapError(() => new GerritPushSigningError({ reason: "signer" })));
    if (
      signed.exitCode !== 0 ||
      signed.stderrTruncated ||
      !/^\[GNUPG:\] SIG_CREATED /m.test(signed.stderr)
    )
      return yield* new GerritPushSigningError({
        reason: /BAD_PASSPHRASE|bad passphrase|No passphrase given/i.test(signed.stderr)
          ? "passphrase-rejected"
          : "signer",
      });
  }
  const program = `${input.directory}/t3-sign-push`;
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  // HTTP authentication uses Git's injected config. Do not pass those headers to GPG.
  const configVariables = Array.from(
    { length: 12 },
    (_, index) => `GIT_CONFIG_KEY_${index} GIT_CONFIG_VALUE_${index}`,
  ).join(" ");
  yield* fs
    .writeFileString(
      program,
      `#!/bin/sh\nunset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS ${configVariables}\nexec ${quote(gpg)} --batch --no-tty --status-fd=2 -bsa${key === undefined || key.length === 0 ? "" : ` -u ${quote(key)}`}\n`,
    )
    .pipe(
      Effect.andThen(fs.chmod(program, 0o700)),
      Effect.mapError(() => new GerritPushSigningError({ reason: "storage" })),
    );
  return {
    args: [
      "-c",
      "gpg.format=openpgp",
      "-c",
      `gpg.program=${program}`,
      "-c",
      `gpg.openpgp.program=${program}`,
      "-c",
      `user.name=${identity?.[1] ?? "T3 Code"}`,
      "-c",
      `user.email=${identity?.[2] ?? "t3@localhost"}`,
    ],
    env,
  };
});
