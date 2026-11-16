import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  SourceControlProviderError,
  SourceControlRepositoryError,
  type GitCommandFailureReason,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  gitLfsDownloadProgressLine,
  isGitFilterProgressLine,
  parseGitCloneProgressLine,
  type GitCloneProgressLine,
} from "../project/gitCloneProgress.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { cloneUrlForProtocol, cloneUrlProtocol } from "@t3tools/shared/cloneUrl";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- rmdir removes only an empty stage wrapper.
import * as NodeFSP from "node:fs/promises";
import * as GerritService from "./GerritService.ts";
import * as GerritClonePublication from "./GerritClonePublication.ts";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);
// An isolated Gerrit clone copies only these host variables.
const hostVariables = (names: ReadonlyArray<string>): NodeJS.ProcessEnv =>
  Object.fromEntries(names.map((name) => [name, process.env[name]]));
const isGitCommandError = Schema.is(GitCommandError);
const isSourceControlProviderError = Schema.is(SourceControlProviderError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    readonly prepareClone: (
      input: SourceControlCloneRepositoryInput,
    ) => Effect.Effect<SourceControlPreparedClone, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    readonly discardClone: (
      destinationPath: string,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    readonly publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
  }
>()("t3/sourceControl/SourceControlRepositoryService") {}

export interface SourceControlPreparedClone {
  readonly destinationPath: string;
  readonly remoteUrl: string;
  readonly cloneUrl: string;
  readonly repository: SourceControlRepositoryInfo | null;
}

export interface SourceControlCloneOptions {
  readonly onProgress?: (line: GitCloneProgressLine) => Effect.Effect<void>;
  readonly onRecoveryPath?: (path: string, remoteUrl: string) => Effect.Effect<void>;
  readonly onPublished?: (remoteUrl: string) => Effect.Effect<void>;
  readonly onPublicationFailure?: (error: SourceControlRepositoryError) => Effect.Effect<void>;
  readonly allowExistingGerritDestination?: boolean;
  /** Overrides the default clone budget; `null` disables the deadline. */
  readonly timeoutMs?: number | null;
}

// Older/mobile synchronous RPCs need deadlines; tracked clones use progress and Cancel instead.
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_ENV = {
  // Force piped progress immediately; refuse credential prompts that would hang without a tty.
  GIT_PROGRESS_DELAY: "0",
  GIT_TERMINAL_PROMPT: "0",
  // English progress without overriding LC_CTYPE, which a global post-checkout hook inherits.
  LANGUAGE: "C",
} satisfies NodeJS.ProcessEnv;
// Well inside the tracker's stall window, at about the pace git itself reports.
const LFS_DOWNLOAD_POLL_INTERVAL = Duration.seconds(2);

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail:
            (isSourceControlProviderError(cause)
              ? SourceControlProvider.userFacingSourceControlDetail(cause.cause)
              : undefined) ?? "The source control operation could not be completed.",
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
    ...(urls.preferredTransport === undefined
      ? {}
      : { preferredTransport: urls.preferredTransport }),
  };
}

// Redact credentials from client clone snapshots; git still receives the credentials.
function redactRemoteUrl(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    // Clone URLs have no legitimate query; when one is present it is a token.
    if (url.username.length === 0 && url.password.length === 0 && url.search.length === 0) {
      return remoteUrl;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return remoteUrl;
  }
}

// Userinfo can contain @; remove through the last one before the host boundary.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi;
// Git leaves quotes inside query tokens unescaped; consume through the closing quote.
const QUOTED_URL_QUERY = /(['"])([a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?.*\1(?=[\s:]|$)/gi;
const URL_QUERY = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?[^\s]*/gi;

function redactUrlCredentials(text: string): string {
  return text
    .replace(QUOTED_URL_QUERY, "$1$2$1")
    .replace(URL_QUERY, "$1")
    .replace(URL_WITH_USERINFO, "$1");
}

// The remote already exists after push failure; advise fixing access and pushing.
// Use fixed text and provider URLs because git stderr can expose credentials.
function publishPushFailureDetail(input: {
  readonly urls: SourceControlRepositoryCloneUrls;
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly reason: GitCommandFailureReason | undefined;
}): string {
  const created = `Created ${input.urls.nameWithOwner} and added it as remote "${input.remoteName}", but the push failed`;
  const switchToHttps = `git remote set-url ${input.remoteName} ${input.urls.url}`;
  const usesSsh = input.remoteUrl === input.urls.sshUrl;
  switch (input.reason) {
    case "authentication_failed":
      return usesSsh
        ? `${created} because SSH authentication was rejected. Add an SSH key to your account, or switch the remote to HTTPS with "${switchToHttps}", then push again.`
        : `${created} because Git could not authenticate. Check your Git credentials, then push again.`;
    case "host_key_unverified":
      return `${created} because the host's SSH key is not trusted yet. Verify it by connecting once with ssh, or switch the remote to HTTPS with "${switchToHttps}", then push again.`;
    default:
      return `${created}. Fix the problem, then push again.`;
  }
}

/**
 * SSH rejection can be retried over HTTPS when the host's credential helper is available.
 * Explicit SSH requests must not fall back; unknown URL shapes must not be guessed.
 */
function httpsFallbackUrl(
  input: SourceControlCloneRepositoryInput,
  prepared: SourceControlPreparedClone,
): string | null {
  if (input.protocol === "ssh" || cloneUrlProtocol(prepared.cloneUrl) !== "ssh") return null;
  if (prepared.repository?.sshUrl === prepared.cloneUrl) return prepared.repository.url;
  return cloneUrlForProtocol(prepared.cloneUrl, "https");
}

const isSshRejection = (error: SourceControlRepositoryError) =>
  isGitCommandError(error.cause) &&
  (error.cause.reason === "authentication_failed" || error.cause.reason === "host_key_unverified");

function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
    case "auto":
      return urls.sshUrl;
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const hostPlatform = yield* HostProcess.Platform;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const gerrit = yield* Effect.serviceOption(GerritService.GerritService);

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(
    function* (input: SourceControlRepositoryLookupInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "lookupRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const urls = yield* provider.getRepositoryCloneUrls({
        cwd: input.cwd ?? config.cwd,
        repository: input.repository.trim(),
      });
      return toRepositoryInfo(providerKind, urls);
    },
    // Someone adding or cloning a repository is waiting, so a background rate-limit pause must not
    // refuse the lookup.
    Effect.provideService(SourceControlRateLimit.Interactive, true),
  );

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: SourceControlProviderKind.make("unknown"),
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePath(trimmed, yield* HostProcess.HomeDirectory));
    },
  );

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (destinationPath: string) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      if (yield* fileSystem.exists(normalizedDestination)) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: "Destination path already exists and is not a directory.",
                  cause,
                }),
            ),
          );
        if (entries.length > 0) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "Destination path already exists and is not empty.",
          });
        }
      } else {
        // Skip existing parents: recursive mkdir on a Windows drive root fails with EPERM.
        const parentPath = path.dirname(normalizedDestination);
        if (!(yield* fileSystem.exists(parentPath))) {
          yield* fileSystem.makeDirectory(parentPath, { recursive: true });
        }
      }

      return {
        destinationPath: normalizedDestination,
        parentPath: path.dirname(normalizedDestination),
        directoryName: path.basename(normalizedDestination),
      };
    },
  );

  const prepareClone = Effect.fn("SourceControlRepositoryService.prepareClone")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    const preparedDestination = yield* prepareDestination(input.destinationPath);
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind =
      input.provider ?? SourceControlProviderKind.make("unknown");

    if (input.provider && input.repository) {
      repository = yield* lookupRepository({
        provider: input.provider,
        repository: input.repository,
        cwd: preparedDestination.parentPath,
      });
      remoteUrl = selectRemoteUrl(repository, input.protocol);
      provider = input.provider;
    }

    if (!remoteUrl) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }

    return {
      destinationPath: preparedDestination.destinationPath,
      remoteUrl: redactRemoteUrl(remoteUrl),
      cloneUrl: remoteUrl,
      repository,
    } satisfies SourceControlPreparedClone;
  });

  // Git and git-lfs print nothing while one object downloads, so a healthy transfer reads as a
  // stall. Its partial files growing are the only sign of life a plain clone gives.
  const watchLfsDownload = (
    destinationPath: string,
    onChange: (partialBytes: number) => Effect.Effect<void>,
  ) => {
    const incomplete = path.join(destinationPath, ".git", "lfs", "incomplete");
    const partialBytes = fileSystem.readDirectory(incomplete).pipe(
      Effect.flatMap(
        Effect.forEach((name) =>
          fileSystem
            .stat(path.join(incomplete, name))
            .pipe(Effect.map((info) => Number(info.size))),
        ),
      ),
      Effect.map((sizes) => sizes.reduce((total, size) => total + size, 0)),
      // No directory means no LFS download; a part that landed mid-read counts on the next poll.
      Effect.orElseSucceed(() => 0),
    );
    return Effect.gen(function* () {
      let previous = 0;
      while (true) {
        yield* Effect.sleep(LFS_DOWNLOAD_POLL_INTERVAL);
        const current = yield* partialBytes;
        if (current > 0 && current !== previous) yield* onChange(current);
        previous = current;
      }
    });
  };
  const installGerritCloneHook = Effect.fn("SourceControlRepositoryService.installGerritCloneHook")(
    function* (
      installation: NonNullable<SourceControlCloneRepositoryInput["gerrit"]>["installation"],
      destinationPath: string,
    ) {
      const fail = () =>
        new SourceControlRepositoryError({
          operation: "installGerritCloneHook",
          provider: SourceControlProviderKind.make("gerrit"),
          detail:
            "The checkout was preserved, but its Gerrit commit-msg hook could not be installed. Check the hook and repository before retrying.",
        });
      if (Option.isNone(gerrit)) return yield* fail();
      const hook = yield* gerrit.value.downloadCloneHook(installation).pipe(Effect.mapError(fail));
      const hookPath = Effect.gen(function* () {
        const gitDirResult = yield* git.execute({
          operation: "SourceControlRepositoryService.hookGitDir",
          cwd: destinationPath,
          args: ["rev-parse", "--absolute-git-dir"],
        });
        const hookResult = yield* git.execute({
          operation: "SourceControlRepositoryService.hookPath",
          cwd: destinationPath,
          args: ["rev-parse", "--path-format=absolute", "--git-path", "hooks/commit-msg"],
        });
        const gitDir = gitDirResult.stdout.replace(/\r?\n$/, "");
        const effective = hookResult.stdout.replace(/\r?\n$/, "");
        if (
          !path.isAbsolute(gitDir) ||
          !path.isAbsolute(effective) ||
          /[\0\r\n]/.test(gitDir + effective)
        )
          return yield* fail();
        const root = yield* fileSystem.realPath(destinationPath);
        const actualGit = yield* fileSystem.realPath(gitDir);
        const directory = path.join(actualGit, "hooks");
        const realDirectory = yield* fileSystem.realPath(directory);
        if (
          actualGit !== path.join(root, ".git") ||
          realDirectory !== directory ||
          path.resolve(effective) !==
            path.join(path.resolve(destinationPath), ".git", "hooks", "commit-msg")
        )
          return yield* fail();
        return { directory, effective };
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const target = yield* hookPath;
          const temp = yield* fileSystem.makeTempDirectoryScoped({
            directory: target.directory,
            prefix: ".t3-commit-msg-",
          });
          const file = path.join(temp, "hook");
          yield* fileSystem.writeFile(file, hook, { flag: "wx", mode: 0o755 });
          yield* fileSystem.chmod(file, 0o755);
          const checked = yield* hookPath;
          if (checked.effective !== target.effective) return yield* fail();
          yield* fileSystem.link(file, target.effective);
        }),
      ).pipe(Effect.mapError(fail));
    },
  );

  const runClone = Effect.fn("SourceControlRepositoryService.runClone")(function* (
    input: SourceControlCloneRepositoryInput,
    destinationPath: string,
    cloneUrl: string,
    options?: SourceControlCloneOptions,
  ) {
    const onProgress = options?.onProgress;
    const selected = input.gerrit;
    const remote = URL.parse(cloneUrl);
    if (selected && remote?.protocol !== "https:" && remote?.protocol !== "http:") {
      if (Option.isNone(gerrit))
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: SourceControlProviderKind.make("gerrit"),
          detail: "Gerrit connection is unavailable.",
        });
      const connection = yield* gerrit.value.readCloneConfig(selected.installation).pipe(
        Effect.mapError(
          () =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: SourceControlProviderKind.make("gerrit"),
              detail: "Gerrit connection is unavailable.",
            }),
        ),
      );
      const ssh = connection?.sshHost;
      const safeProject = selected.project
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\\"));
      const expected =
        ssh?.username &&
        /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(ssh.host) &&
        Number.isInteger(ssh.port ?? 29418) &&
        (ssh.port ?? 29418) >= 1 &&
        (ssh.port ?? 29418) <= 65535
          ? `ssh://${ssh.username}@${ssh.host}:${ssh.port ?? 29418}/${selected.project.split("/").map(encodeURIComponent).join("/")}`
          : null;
      if (
        !safeProject ||
        expected === null ||
        cloneUrl !== expected ||
        URL.parse(expected)?.href !== expected
      )
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: SourceControlProviderKind.make("gerrit"),
          detail: "The selected Gerrit project does not match a configured SSH identity.",
        });
    }
    const authenticated =
      selected !== undefined && (remote?.protocol === "https:" || remote?.protocol === "http:");
    let cloneEnv: NodeJS.ProcessEnv = CLONE_ENV;
    if (selected && remote?.protocol === "ssh:") {
      // SSH aliases and proxy commands can change the endpoint just like Git rewrites.
      // Retain the SSH agent, but require the configured host and default SSH identities.
      cloneEnv = {
        ...CLONE_ENV,
        ...hostVariables(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SSH_AUTH_SOCK"]),
        GIT_SSH_COMMAND: hostPlatform === "win32" ? "ssh -F NUL" : "ssh -F /dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: hostPlatform === "win32" ? "NUL" : "/dev/null",
        GIT_CEILING_DIRECTORIES: path.dirname(destinationPath),
        GIT_CONFIG_PARAMETERS: "",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "protocol.allow",
        GIT_CONFIG_VALUE_0: "never",
        GIT_CONFIG_KEY_1: "protocol.ssh.allow",
        GIT_CONFIG_VALUE_1: "always",
      };
    }
    if (authenticated) {
      const encoded = selected.project.split("/").map(encodeURIComponent).join("/");
      const expected = `${selected.installation}a/${encoded}`;
      if (
        selected.project
          .split("/")
          .some((part) => part === "" || part === "." || part === ".." || part.includes("\\")) ||
        cloneUrl !== expected ||
        URL.parse(expected)?.href !== expected
      ) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: SourceControlProviderKind.make("gerrit"),
          detail: "The selected Gerrit project does not match the clone URL.",
        });
      }
      if (Option.isNone(gerrit)) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: SourceControlProviderKind.make("gerrit"),
          detail: "Gerrit credentials are unavailable.",
        });
      }
      const auth = yield* gerrit.value.resolveCloneAuth(selected.installation).pipe(
        Effect.mapError(
          () =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: SourceControlProviderKind.make("gerrit"),
              detail: "Gerrit credentials are unavailable. Check Source Control settings.",
            }),
        ),
      );
      const credentials = Redacted.value(auth.credentials);
      const header = Buffer.from(`${credentials.username}:${credentials.token}`).toString("base64");
      // A clone must not inherit rewrites, helpers, proxies, trace settings, or redirects.
      // The URL-scoped header and disabled redirects also protect HTTP alternates.
      cloneEnv = {
        ...CLONE_ENV,
        ...hostVariables(["PATH", "SYSTEMROOT", "TEMP", "TMP"]),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: hostPlatform === "win32" ? "NUL" : "/dev/null",
        GIT_CEILING_DIRECTORIES: path.dirname(destinationPath),
        GIT_CONFIG_PARAMETERS: "",
        GIT_CONFIG_COUNT: "8",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: `http.${expected}.extraHeader`,
        GIT_CONFIG_VALUE_1: `Authorization: Basic ${header}`,
        GIT_CONFIG_KEY_2: "credential.helper",
        GIT_CONFIG_VALUE_2: "",
        GIT_CONFIG_KEY_3: "http.followRedirects",
        GIT_CONFIG_VALUE_3: "false",
        GIT_CONFIG_KEY_4: "http.proxy",
        GIT_CONFIG_VALUE_4: "",
        GIT_CONFIG_KEY_5: "http.cookieFile",
        GIT_CONFIG_VALUE_5: "",
        GIT_CONFIG_KEY_6: "protocol.allow",
        GIT_CONFIG_VALUE_6: "never",
        GIT_CONFIG_KEY_7: `protocol.${remote.protocol.slice(0, -1)}.allow`,
        GIT_CONFIG_VALUE_7: "always",
      };
    }
    // Git interleaves progress redraws with its real messages on stderr. The
    // last non-progress lines are what explain a failure ("Repository not
    // found", "Permission denied"), so keep them for the error detail.
    const stderrTail: Array<string> = [];
    let filterPercent: number | null = null;
    const onStderrLine = (line: string) => {
      const parsed = parseGitCloneProgressLine(line);
      if (parsed && isGitFilterProgressLine(line)) filterPercent = parsed.percent;
      // Remote messages are untrusted and may echo the credential.
      if (parsed)
        return onProgress
          ? onProgress(authenticated ? { ...parsed, detail: null } : parsed)
          : Effect.void;
      if (authenticated) return Effect.void;
      return Effect.sync(() => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("Cloning into")) return;
        // Git echoes the remote in some failures; the tail becomes user-facing text.
        stderrTail.push(redactUrlCredentials(trimmed));
        if (stderrTail.length > 4) stderrTail.shift();
      });
    };
    // Git misreads @ in a pathless URL's query as userinfo and echoes its suffix as the host.
    const normalizedCloneUrl = cloneUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)\?/i, "$1/?");
    const provider = input.provider ?? SourceControlProviderKind.make("unknown");
    const timeoutMs = options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs;
    const clone = git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: path.dirname(destinationPath),
        args: ["clone", "--progress", "--", normalizedCloneUrl, path.basename(destinationPath)],
        // The deadline is applied below so a timeout is reported as one, not as git's last line.
        timeoutMs: null,
        // Buffered output is unused and progress can be huge; cap it while retaining line callbacks.
        maxOutputBytes: 256 * 1024,
        appendTruncationMarker: true,
        keepLineCallbacksAfterTruncation: true,
        env: cloneEnv,
        isolatedEnv: selected !== undefined,
        progress: { onStderrLine },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider,
              detail:
                !authenticated && stderrTail.length > 0
                  ? stderrTail.join(" ")
                  : "The repository could not be cloned.",
              ...(authenticated ? {} : { cause }),
            }),
        ),
      );
    const watchedClone = onProgress
      ? clone.pipe(
          Effect.raceFirst(
            watchLfsDownload(destinationPath, (partialBytes) =>
              onProgress(gitLfsDownloadProgressLine(partialBytes, filterPercent)),
            ),
          ),
        )
      : clone;
    if (timeoutMs === null) return yield* watchedClone;
    // Interrupting the clone closes the scope that owns git, which kills it.
    return yield* watchedClone.pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider,
              detail: `The clone timed out after ${Duration.format(Duration.millis(timeoutMs))}.`,
            }),
          ),
      }),
    );
  });

  const cloneOnce = Effect.fn("SourceControlRepositoryService.cloneOnce")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    const prepared = yield* prepareClone(input);
    const httpsUrl = httpsFallbackUrl(input, prepared);
    const remoteUrl = yield* runClone(
      input,
      prepared.destinationPath,
      prepared.cloneUrl,
      options,
    ).pipe(
      Effect.as(prepared.remoteUrl),
      // @effect-diagnostics-next-line catchConditionalRefailToCatchIf:off - The condition also narrows httpsUrl for the fallback closure.
      Effect.catch((sshError) =>
        httpsUrl === null || !isSshRejection(sshError)
          ? Effect.fail(sshError)
          : runClone(input, prepared.destinationPath, httpsUrl, options).pipe(
              Effect.as(redactRemoteUrl(httpsUrl)),
              Effect.mapError(
                (httpsError) =>
                  new SourceControlRepositoryError({
                    operation: "cloneRepository",
                    provider: sshError.provider,
                    detail: `${sshError.detail} Cloning over HTTPS instead also failed: ${httpsError.detail}`,
                    cause: httpsError.cause,
                  }),
              ),
            ),
      ),
    );

    // A ref list read while the clone ran saw an unborn HEAD and no refs.
    yield* git.invalidateRefs(prepared.destinationPath);
    if (input.gerrit)
      yield* installGerritCloneHook(input.gerrit.installation, prepared.destinationPath);

    return {
      cwd: prepared.destinationPath,
      remoteUrl,
      repository: prepared.repository,
    };
  });

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    if (!input.gerrit) return yield* cloneOnce(input, options);
    const selected = input.gerrit;
    const prepared = yield* prepareClone(input);
    const encoded = selected.project.split("/").map(encodeURIComponent).join("/");
    const safeProject = selected.project
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\\"));
    const httpUrl = `${selected.installation}a/${encoded}`;
    if (Option.isNone(gerrit))
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider: SourceControlProviderKind.make("gerrit"),
        detail: "Gerrit connection is unavailable.",
      });
    const connection = yield* gerrit.value.readCloneConfig(selected.installation).pipe(
      Effect.mapError(
        () =>
          new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("gerrit"),
            detail: "Gerrit connection is unavailable.",
          }),
      ),
    );
    const ssh = connection?.sshHost;
    const sshUrl =
      ssh?.username &&
      /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(ssh.host) &&
      Number.isInteger(ssh.port ?? 29418) &&
      (ssh.port ?? 29418) >= 1 &&
      (ssh.port ?? 29418) <= 65535
        ? `ssh://${ssh.username}@${ssh.host}:${ssh.port ?? 29418}/${encoded}`
        : null;
    if (
      !connection ||
      !safeProject ||
      URL.parse(httpUrl)?.href !== httpUrl ||
      (prepared.cloneUrl !== httpUrl && prepared.cloneUrl !== sshUrl)
    )
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider: SourceControlProviderKind.make("gerrit"),
        detail: "The selected Gerrit project does not match the configured installation.",
      });
    const attempt = Effect.fn("SourceControlRepositoryService.stagedAttempt")(function* (
      remoteUrl: string,
    ) {
      const stage = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const created = yield* fileSystem.makeTempDirectory({
            directory: path.dirname(prepared.destinationPath),
            prefix: ".t3-gerrit-clone-",
          });
          if (options?.onRecoveryPath)
            yield* options.onRecoveryPath(created, redactRemoteUrl(remoteUrl));
          return created;
        }),
      );
      const checkout = path.join(stage, "checkout");
      const result = yield* cloneOnce(
        { remoteUrl, destinationPath: checkout, gerrit: selected },
        options,
      ).pipe(Effect.result);
      return { stage, checkout, result };
    });
    const first = yield* attempt(sshUrl ?? httpUrl);
    let final = first;
    if (sshUrl && first.result._tag === "Failure") {
      const error = first.result.failure;
      if (
        isSourceControlRepositoryError(error) &&
        error.operation === "cloneRepository" &&
        isGitCommandError(error.cause) &&
        error.cause.exitCode !== undefined &&
        error.cause.exitCode !== 0
      )
        final = yield* attempt(httpUrl);
    }
    const earlierAttempt =
      final.stage === first.stage ? "" : ` Earlier SSH attempt: ${first.stage}.`;
    if (final.result._tag === "Failure") {
      const error = final.result.failure;
      return yield* new SourceControlRepositoryError({
        operation: isSourceControlRepositoryError(error) ? error.operation : "cloneRepository",
        provider: SourceControlProviderKind.make("gerrit"),
        detail: `${isSourceControlRepositoryError(error) && error.detail === "Gerrit credentials are unavailable. Check Source Control settings." ? error.detail : "Clone or hook setup failed."} The private attempt was preserved at ${final.stage}. Inspect it before retrying.${earlierAttempt}`,
      });
    }
    const result = final.result.success;
    const cloneUrl = final === first ? (sshUrl ?? httpUrl) : httpUrl;
    yield* gerrit.value.bindVerifiedClone({ ...selected, url: cloneUrl }).pipe(
      Effect.mapError(
        () =>
          new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("gerrit"),
            detail: `The Gerrit clone binding could not be saved. The private checkout is preserved at ${final.checkout}. Inspect its settings before retrying.${earlierAttempt}`,
          }),
      ),
    );
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const outcome = yield* GerritClonePublication.publish({
          stage: final.stage,
          checkout: final.checkout,
          destination: prepared.destinationPath,
        });
        if (outcome.status === "published") {
          if (options?.onPublished) yield* options.onPublished(result.remoteUrl);
          // Remove only an empty wrapper; never recursively remove recovery data.
          yield* Effect.promise(() => NodeFSP.rmdir(final.stage).catch(() => {}));
          return { ...result, cwd: prepared.destinationPath };
        }
        const detail = `Publication was rejected. The private checkout is preserved at ${final.checkout}; the destination ${prepared.destinationPath} was not replaced. Inspect the paths before taking action.`;
        const error = new SourceControlRepositoryError({
          operation: "publishGerritClone",
          provider: SourceControlProviderKind.make("gerrit"),
          detail: `${detail}${earlierAttempt}`,
        });
        if (options?.onPublicationFailure) yield* options.onPublicationFailure(error);
        return yield* error;
      }),
    );
  });

  const discardClone = Effect.fn("SourceControlRepositoryService.discardClone")(function* (
    destinationPath: string,
  ) {
    const normalized = yield* normalizeDestinationPath(destinationPath);
    // Only .git-bearing partial clones may be deleted; other files arrived after the empty-directory check.
    // Missing destinations are already discarded; other read failures must refuse removal.
    const entries = yield* fileSystem.readDirectory(normalized).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "The clone destination could not be inspected.",
            cause,
          }),
      ),
    );
    if (entries.length > 0 && !entries.includes(".git")) {
      return yield* new SourceControlRepositoryError({
        operation: "discardClone",
        provider: SourceControlProviderKind.make("unknown"),
        detail: "Destination path contains files that are not from the clone.",
      });
    }
    // Preserve the workspace directory after removing partial contents; retry while interrupted git closes files.
    yield* fileSystem.remove(normalized, { recursive: true, force: true }).pipe(
      Effect.andThen(fileSystem.makeDirectory(normalized, { recursive: true })),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 5 }),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "The partial clone could not be removed.",
            cause,
          }),
      ),
    );
  });

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const urls = yield* provider.createRepository({
        cwd: input.cwd,
        repository: input.repository.trim(),
        visibility: input.visibility,
      });
      const remoteUrl = selectRemoteUrl(urls, input.protocol);
      const remoteName = yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: input.remoteName?.trim() || "origin",
        url: remoteUrl,
      });

      // Empty repos cannot push HEAD; report partial success because the remote already exists.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (!hasCommits) {
        const details = yield* git.statusDetails(input.cwd).pipe(Effect.orElseSucceed(() => null));
        return {
          repository: toRepositoryInfo(providerKind, urls),
          remoteName,
          remoteUrl,
          branch: details?.branch ?? "main",
          status: "remote_added" as const,
        };
      }

      const push = (pushUrl: string) =>
        git.pushCurrentBranch(input.cwd, null, { remoteName }).pipe(
          Effect.map((result) => ({ branch: result.branch, remoteUrl: pushUrl })),
          Effect.mapError(
            (cause) =>
              new SourceControlRepositoryError({
                operation: "publishRepository",
                provider: providerKind,
                detail: publishPushFailureDetail({
                  urls,
                  remoteName,
                  remoteUrl: pushUrl,
                  reason: cause.reason,
                }),
                cause,
              }),
          ),
        );

      // Like clone, an auto-selected SSH remote switches to HTTPS when SSH is refused;
      // otherwise the remote keeps failing every later fetch and push.
      const canSwitchToHttps = input.protocol !== "ssh" && remoteUrl === urls.sshUrl;
      const pushed = yield* push(remoteUrl).pipe(
        Effect.catchIf(
          (error) => canSwitchToHttps && isSshRejection(error),
          (sshError) =>
            git
              .execute({
                operation: "SourceControlRepositoryService.publishRepository.switchToHttps",
                cwd: input.cwd,
                args: ["remote", "set-url", remoteName, urls.url],
              })
              .pipe(
                Effect.mapError(() => sshError),
                Effect.andThen(push(urls.url)),
              ),
        ),
      );

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl: pushed.remoteUrl,
        branch: pushed.branch,
        status: "pushed" as const,
      };
    },
  );

  // Forwarders retain the underlying operation spans.
  return SourceControlRepositoryService.of({
    lookupRepository: Effect.fnUntraced(function* (input) {
      return yield* lookupRepository(input).pipe(
        mapRepositoryError("lookupRepository", input.provider),
      );
    }),
    prepareClone: Effect.fnUntraced(function* (input) {
      return yield* prepareClone(input).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      );
    }),
    cloneRepository: Effect.fnUntraced(function* (input, options) {
      return yield* cloneRepository(input, options).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      );
    }),
    discardClone: Effect.fnUntraced(function* (destinationPath) {
      return yield* discardClone(destinationPath).pipe(
        mapRepositoryError("discardClone", SourceControlProviderKind.make("unknown")),
      );
    }),
    publishRepository: Effect.fnUntraced(function* (input) {
      return yield* publishRepository(input).pipe(
        mapRepositoryError("publishRepository", input.provider),
      );
    }),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
