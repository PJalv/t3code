import {
  GerritConnectionError,
  type GerritConnection,
  type GerritDeliveryCheckout,
  GerritDeliveryCheckoutInput,
  GerritProjectSearchInput,
  type GerritChangesSearchInput,
  type GerritChangesSearchResult,
  type GerritProjectSearchResult,
} from "@t3tools/contracts";
export { GerritConnectionError } from "@t3tools/contracts";
import {
  gerritRemoteConfiguration,
  resolveRemoteEndpoint,
} from "@t3tools/source-control-gerrit/server/remoteBinding";
import { commitIdentity } from "@t3tools/source-control-gerrit/server/localCommitMapping";
import * as Digest from "effect/crypto/Digest";
import * as Context from "effect/Context";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitHttpAuth from "../vcs/GitHttpAuth.ts";
import { parseWorktreeStatus } from "./gerritWorktreeStatus.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  GerritSetSigningPassphraseInput,
  type GerritSigningPassphraseStatus,
  GerritHookError,
  GerritHookInput,
  type GerritHookDiagnosis,
  GerritConnectionConfig,
  GerritWriteError,
  GerritReviewInput,
  GerritFilesInput,
  type GerritReviewDetail,
  type GerritFile,
  GerritInstallationId,
  type GerritChangeKey,
  type GerritChangeNumber,
  type GerritReadChange,
  GitCommitOid,
} from "@t3tools/contracts";
import * as GerritHttp from "@t3tools/source-control-gerrit/server/GerritHttp";
import { makeHookOperations } from "@t3tools/source-control-gerrit/server/hookSetup";
import * as GerritBranchReviews from "./gerritBranchReviews.ts";
import * as GerritRemotes from "@t3tools/source-control-gerrit/server/GerritRemotes";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import {
  GerritRemoteConfiguration,
  type GerritRemoteRepository,
} from "@t3tools/source-control-gerrit/server/remoteBinding";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";

type ReadError = GerritConnectionError | GerritHttp.GerritReadError;
type Connection = GerritConnection;
export class GerritService extends Context.Service<
  GerritService,
  {
    readonly readHook: (
      input: typeof GerritHookInput.Type,
    ) => Effect.Effect<GerritHookDiagnosis, GerritHookError>;
    readonly installHook: (
      session: EnvironmentAuth.AuthenticatedSession,
      input: typeof GerritHookInput.Type,
    ) => Effect.Effect<GerritHookDiagnosis, GerritHookError | GerritConnectionError>;
    readonly readReview: (input: GerritReviewInput) => Effect.Effect<GerritReviewDetail, ReadError>;
    readonly readFiles: (
      input: typeof GerritFilesInput.Type,
    ) => Effect.Effect<ReadonlyArray<typeof GerritFile.Type>, ReadError>;
    readonly listConnections: Effect.Effect<ReadonlyArray<Connection>, GerritConnectionError>;
    readonly searchProjects: (
      input: typeof GerritProjectSearchInput.Type,
    ) => Effect.Effect<GerritProjectSearchResult, ReadError>;
    readonly downloadCloneHook: (
      installation: GerritInstallationId,
    ) => Effect.Effect<Uint8Array, ReadError>;
    readonly readCloneConfig: (
      installation: GerritInstallationId,
    ) => Effect.Effect<GerritConnectionConfig | null, GerritConnectionError>;
    readonly bindVerifiedClone: (input: {
      readonly installation: GerritInstallationId;
      readonly project: GerritRemoteRepository["project"];
      readonly url: string;
    }) => Effect.Effect<void, GerritConnectionError>;
    readonly resolveCloneAuth: (installation: GerritInstallationId) => Effect.Effect<
      {
        readonly installation: GerritInstallationId;
        readonly credentials: GerritHttp.GerritHttpCredentials;
      },
      GerritConnectionError
    >;
    readonly configureFromClient: (input: {
      readonly config: GerritConnectionConfig;
      readonly credentials?: unknown;
    }) => Effect.Effect<Connection, GerritConnectionError>;
    readonly removeCredentials: (
      installation: GerritInstallationId,
    ) => Effect.Effect<void, GerritConnectionError>;
    readonly signingPassphraseStatus: Effect.Effect<
      GerritSigningPassphraseStatus,
      GerritConnectionError
    >;
    /** Saves the environment's GPG key passphrase, or clears it when `passphrase` is null. */
    readonly setSigningPassphrase: (
      input: GerritSetSigningPassphraseInput,
    ) => Effect.Effect<GerritSigningPassphraseStatus, GerritConnectionError>;
    /** Resolve the checkout itself to the single amendable Gerrit change. Read-only. */
    readonly deliveryCheckout: (
      input: typeof GerritDeliveryCheckoutInput.Type,
    ) => Effect.Effect<GerritDeliveryCheckout, ReadError>;
    readonly configureConnection: (input: {
      readonly config: GerritConnectionConfig;
      readonly credentials: GerritHttp.GerritHttpCredentials;
    }) => Effect.Effect<Connection, GerritConnectionError>;
    readonly readConnection: (
      installation: GerritInstallationId,
    ) => Effect.Effect<Connection | null, GerritConnectionError>;
    readonly testConnection: (
      installation: GerritInstallationId,
    ) => Effect.Effect<GerritHttp.Verification, ReadError>;
    readonly removeConnection: (
      installation: GerritInstallationId,
    ) => Effect.Effect<void, GerritConnectionError>;
    readonly searchChanges: (
      input: GerritChangesSearchInput,
    ) => Effect.Effect<GerritChangesSearchResult, ReadError>;
    readonly getChangeByNumber: (input: {
      readonly installation: GerritInstallationId;
      readonly number: typeof GerritChangeNumber.Type;
    }) => Effect.Effect<
      { readonly connection: GerritHttp.Verification; readonly change: GerritReadChange },
      ReadError
    >;
    readonly getRelatedChanges: (input: {
      readonly key: GerritChangeKey;
      readonly number: typeof GerritChangeNumber.Type;
      readonly revision: GitCommitOid;
    }) => Effect.Effect<
      { readonly connection: GerritHttp.Verification; readonly related: GerritHttp.RelatedChanges },
      ReadError
    >;
    /** The related ancestry plus same-topic changes, with stale-parent and rebase facts. */
  }
>()("t3/sourceControl/GerritService") {}

const decodeInstallation = Schema.decodeEffect(GerritInstallationId);
const credentialCodec = Schema.fromJsonString(GerritHttp.GerritHttpCredentialValue);

const decodeConfig = Schema.decodeEffect(GerritConnectionConfig);
const decodeCredentials = Schema.decodeEffect(GerritHttp.GerritHttpCredentials);
const decodeClientCredentials = Schema.decodeUnknownEffect(GerritHttp.GerritHttpCredentialValue);
const decodeRemoteConfig = Schema.decodeUnknownEffect(GerritRemoteConfiguration);
const decodeCredentialValue = Schema.decodeEffect(credentialCodec);
const encodeCredentialValue = Schema.encodeEffect(credentialCodec);
const decodeHookInput = Schema.decodeUnknownEffect(GerritHookInput);
const decodeDeliveryCheckoutInput = Schema.decodeUnknownEffect(GerritDeliveryCheckoutInput);
const decodeCommitOid = Schema.decodeUnknownEffect(GitCommitOid);
const decodeSetSigningPassphrase = Schema.decodeUnknownEffect(GerritSetSigningPassphraseInput);
const SIGNING_PASSPHRASE_SECRET = "gerrit-gpg-signing-passphrase";

const make = Effect.gen(function* () {
  const crypto = yield* Digest.Digest;
  const appAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  // One derivation for the credential secret, shared with branch review linkage so both read
  // and write the same entry.
  const secretName = (installation: GerritInstallationId) =>
    GerritBranchReviews.credentialSecretName(crypto, installation).pipe(
      Effect.mapError(() => new GerritConnectionError({ reason: "secret-store" })),
    );
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* GerritHttp.GerritHttp;
  // Patch-set staleness shares the configured Gerrit credentials.
  const remotes = yield* GerritRemotes.GerritRemotes;
  const host = yield* SourceControlHost.SourceControlHost;
  const fs = yield* FileSystem.FileSystem;
  const mutations = yield* Semaphore.make(1);
  const gitHttpAuth = yield* Effect.serviceOption(GitHttpAuth.GitHttpAuth);
  const invalidateGitHttpAuth = Option.isSome(gitHttpAuth)
    ? gitHttpAuth.value.invalidate
    : Effect.void;
  const hooks = yield* makeHookOperations;
  const readHook = Effect.fn("GerritService.readHook")(function* (
    raw: typeof GerritHookInput.Type,
  ) {
    const input = yield* decodeHookInput(raw).pipe(
      Effect.mapError((cause) => new GerritHookError({ reason: "invalid-input", cause })),
    );
    return yield* hooks.readHook(input.cwd);
  });
  const getSettings = settings.getSettings.pipe(
    Effect.mapError(() => new GerritConnectionError({ reason: "settings" })),
  );
  const validateInstallation = (installation: GerritInstallationId) =>
    decodeInstallation(installation).pipe(
      Effect.mapError(() => new GerritConnectionError({ reason: "invalid-input" })),
    );
  const readSecret = (installation: GerritInstallationId) =>
    secretName(installation).pipe(
      Effect.flatMap(secrets.get),
      Effect.mapError(() => new GerritConnectionError({ reason: "secret-store" })),
    );
  const readConnection = Effect.fn("GerritService.readConnection")(function* (
    input: GerritInstallationId,
  ) {
    const installation = yield* validateInstallation(input);
    const config = (yield* getSettings).gerritConnections[installation];
    if (config === undefined) return null;
    return {
      config,
      credentialPresent: Option.isSome(yield* readSecret(installation)),
      verification: "not-tested",
    } satisfies Connection;
  }, mutations.withPermits(1));
  const resolveAuth = Effect.fn("GerritService.resolveAuth")(function* (
    input: GerritInstallationId,
  ) {
    const installation = yield* validateInstallation(input);
    const config = (yield* getSettings).gerritConnections[installation];
    if (config === undefined) return yield* new GerritConnectionError({ reason: "not-configured" });
    if (config.installation !== installation)
      return yield* new GerritConnectionError({ reason: "invalid-input" });
    const stored = yield* readSecret(installation);
    if (Option.isNone(stored))
      return yield* new GerritConnectionError({ reason: "credentials-missing" });
    const value = yield* decodeCredentialValue(new TextDecoder().decode(stored.value)).pipe(
      Effect.mapError(() => new GerritConnectionError({ reason: "credentials-invalid" })),
    );
    return {
      installation,
      credentials: Redacted.make(value),
      bindings: config.bindings,
      ...(config.sshHost ? { sshHost: config.sshHost } : {}),
      ...(config.checksProfile ? { checksProfile: config.checksProfile } : {}),
    };
  });
  const configureConnection = Effect.fn("GerritService.configureConnection")(function* (input: {
    readonly config: GerritConnectionConfig;
    readonly credentials?: GerritHttp.GerritHttpCredentials;
  }) {
    if (input.config.authMode !== "http-basic")
      return yield* new GerritConnectionError({ reason: "unsupported-auth" });
    const config = yield* decodeConfig(input.config).pipe(
      Effect.mapError(() => new GerritConnectionError({ reason: "invalid-input" })),
    );
    const credentials =
      input.credentials === undefined
        ? undefined
        : yield* decodeCredentials(input.credentials).pipe(
            Effect.mapError(() => new GerritConnectionError({ reason: "credentials-invalid" })),
          );
    yield* decodeRemoteConfig({
      confirmedInstallations: [config.installation],
      exactBindings: config.bindings.map((binding) => ({
        url: binding.url,
        repository: { installation: config.installation, project: binding.project },
      })),
    }).pipe(Effect.mapError(() => new GerritConnectionError({ reason: "invalid-input" })));
    const encoded =
      credentials === undefined
        ? undefined
        : yield* encodeCredentialValue(Redacted.value(credentials)).pipe(
            Effect.mapError(() => new GerritConnectionError({ reason: "credentials-invalid" })),
          );
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const name = yield* secretName(config.installation);
        const previous = yield* readSecret(config.installation);
        if (encoded === undefined) {
          const existing = (yield* getSettings).gerritConnections[config.installation];
          if (existing === undefined || existing.installation !== config.installation)
            return yield* new GerritConnectionError({ reason: "not-configured" });
          if (Option.isNone(previous))
            return yield* new GerritConnectionError({ reason: "credentials-missing" });
          yield* decodeCredentialValue(new TextDecoder().decode(previous.value)).pipe(
            Effect.mapError(() => new GerritConnectionError({ reason: "credentials-invalid" })),
          );
          yield* settings
            .updateSettings({ gerritConnections: { [config.installation]: config } })
            .pipe(Effect.mapError(() => new GerritConnectionError({ reason: "settings" })));
          return;
        }
        const restore = (
          Option.isSome(previous) ? secrets.set(name, previous.value) : secrets.remove(name)
        ).pipe(Effect.mapError(() => new GerritConnectionError({ reason: "secret-store" })));
        yield* secrets.set(name, new TextEncoder().encode(encoded)).pipe(
          Effect.mapError(() => new GerritConnectionError({ reason: "secret-store" })),
          Effect.tapError(() => restore),
        );
        yield* settings
          .updateSettings({ gerritConnections: { [config.installation]: config } })
          .pipe(
            Effect.mapError(() => new GerritConnectionError({ reason: "settings" })),
            Effect.tapError(() => restore),
          );
      }),
    );
    yield* invalidateGitHttpAuth;
    return { config, credentialPresent: true, verification: "not-tested" } satisfies Connection;
  }, mutations.withPermits(1));
  const removeConnection = Effect.fn("GerritService.removeConnection")(function* (
    input: GerritInstallationId,
  ) {
    const installation = yield* validateInstallation(input);
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const name = yield* secretName(installation);
        const previous = yield* readSecret(installation);
        yield* secrets
          .remove(name)
          .pipe(Effect.mapError(() => new GerritConnectionError({ reason: "secret-store" })));
        yield* settings.updateSettings({ gerritConnections: { [installation]: null } }).pipe(
          Effect.mapError(() => new GerritConnectionError({ reason: "settings" })),
          Effect.tapError(() =>
            Option.isSome(previous)
              ? secrets
                  .set(name, previous.value)
                  .pipe(
                    Effect.mapError(() => new GerritConnectionError({ reason: "secret-store" })),
                  )
              : Effect.void,
          ),
        );
      }),
    );
    yield* invalidateGitHttpAuth;
  }, mutations.withPermits(1));
  const testConnection = Effect.fn("GerritService.testConnection")(function* (
    installation: GerritInstallationId,
  ) {
    return yield* http.verify(yield* resolveAuth(installation));
  }, mutations.withPermits(1));
  const searchChanges = Effect.fn("GerritService.searchChanges")(function* (
    input: GerritChangesSearchInput,
  ) {
    // Take a consistent config/credential snapshot, but do not hold the mutation lock during I/O.
    const auth = yield* resolveAuth(input.installation).pipe(mutations.withPermits(1));
    return yield* http.searchChanges({ ...auth, ...input });
  });
  const getChangeByNumber = Effect.fn("GerritService.getChangeByNumber")(function* (input: {
    readonly installation: GerritInstallationId;
    readonly number: typeof GerritChangeNumber.Type;
  }) {
    const auth = yield* resolveAuth(input.installation);
    const connection = yield* http.verify(auth);
    const change = yield* http.getChangeByNumber({ ...auth, number: input.number });
    return { connection, change };
  }, mutations.withPermits(1));
  const getRelatedChanges = Effect.fn("GerritService.getRelatedChanges")(function* (input: {
    readonly key: GerritChangeKey;
    readonly number: typeof GerritChangeNumber.Type;
    readonly revision: GitCommitOid;
  }) {
    const auth = yield* resolveAuth(input.key.installation);
    const connection = yield* http.verify(auth);
    const related = yield* http.getRelatedChanges({ ...auth, ...input });
    return { connection, related };
  }, mutations.withPermits(1));
  const listConnections = Effect.gen(function* () {
    const configs = Object.values((yield* getSettings).gerritConnections);
    return yield* Effect.forEach(configs, (config) =>
      readConnection(config.installation).pipe(
        Effect.map(
          (connection) =>
            connection ?? { config, credentialPresent: false, verification: "not-tested" as const },
        ),
      ),
    );
  });
  const searchProjects = Effect.fn("GerritService.searchProjects")(function* (
    input: typeof GerritProjectSearchInput.Type,
  ) {
    const configs = Object.values((yield* getSettings).gerritConnections);
    const query = input.query.trim();
    const results: Array<GerritProjectSearchResult["results"][number]> = [];
    const failures: Array<GerritProjectSearchResult["failures"][number]> = [];
    if (query.length === 0) return { configuredInstallations: configs.length, results, failures };
    yield* Effect.forEach(
      configs,
      (config) =>
        Effect.gen(function* () {
          const auth = yield* resolveAuth(config.installation);
          const projects = yield* http.searchProjects({ ...auth, query });
          const installation = URL.parse(config.installation);
          if (installation === null) throw new Error("Invalid Gerrit installation URL");
          const sshHost = config.sshHost;
          const sshConfigured =
            sshHost !== undefined &&
            sshHost.username !== undefined &&
            /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(sshHost.host) &&
            Number.isInteger(sshHost.port ?? 29418) &&
            (sshHost.port ?? 29418) >= 1 &&
            (sshHost.port ?? 29418) <= 65535;
          for (const project of projects) {
            const encoded = project.split("/").map(encodeURIComponent).join("/");
            results.push({
              installation: config.installation,
              project: project as GerritProjectSearchResult["results"][number]["project"],
              httpUrl: `${config.installation}a/${encoded}`,
              projectUrl: `${config.installation}q/project:${encoded}`,
              sshUrl: sshConfigured
                ? `ssh://${sshHost.username}@${sshHost.host}:${sshHost.port ?? 29418}/${encoded}`
                : `ssh://${installation.hostname}:29418/${encoded}`,
              ...(sshConfigured ? { preferredTransport: "ssh" as const } : {}),
            });
          }
        }).pipe(
          Effect.catch(() => {
            failures.push({
              installation: config.installation,
              detail: "Could not search this installation.",
            });
            return Effect.void;
          }),
        ),
      { concurrency: 4 },
    );
    return {
      configuredInstallations: configs.length,
      results,
      failures,
    } satisfies GerritProjectSearchResult;
  });
  const configureFromClient = Effect.fn("GerritService.configureFromClient")(function* (input: {
    readonly config: GerritConnectionConfig;
    readonly credentials?: unknown;
  }) {
    if (input.credentials === undefined)
      return yield* configureConnection({ config: input.config });
    const value = yield* decodeClientCredentials(input.credentials).pipe(
      Effect.mapError(() => new GerritConnectionError({ reason: "credentials-invalid" })),
    );
    return yield* configureConnection({ config: input.config, credentials: Redacted.make(value) });
  });
  // One passphrase per environment: the signing key belongs to the machine's Git identity, not to
  // a Gerrit server. The value is never returned to a client.
  const readSigningPassphrase = secrets.get(SIGNING_PASSPHRASE_SECRET).pipe(
    Effect.map(Option.map((bytes) => Redacted.make(new TextDecoder().decode(bytes)))),
    Effect.mapError(() => new GerritConnectionError({ reason: "secret-store" })),
  );
  const signingPassphraseStatus = readSigningPassphrase.pipe(
    Effect.map((value) => ({ present: Option.isSome(value) })),
  );
  const setSigningPassphrase = Effect.fn("GerritService.setSigningPassphrase")(function* (
    input: GerritSetSigningPassphraseInput,
  ) {
    const decoded = yield* decodeSetSigningPassphrase(input).pipe(
      Effect.mapError(() => new GerritConnectionError({ reason: "invalid-input" })),
    );
    yield* (
      decoded.passphrase === null
        ? secrets.remove(SIGNING_PASSPHRASE_SECRET)
        : secrets.set(SIGNING_PASSPHRASE_SECRET, new TextEncoder().encode(decoded.passphrase))
    ).pipe(Effect.mapError(() => new GerritConnectionError({ reason: "secret-store" })));
    return { present: decoded.passphrase !== null };
  }, mutations.withPermits(1));
  const removeCredentials = Effect.fn("GerritService.removeCredentials")(function* (
    input: GerritInstallationId,
  ) {
    const installation = yield* validateInstallation(input);
    const name = yield* secretName(installation);
    const previous = yield* readSecret(installation);
    const config = (yield* getSettings).gerritConnections[installation];
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* secrets
          .remove(name)
          .pipe(Effect.mapError(() => new GerritConnectionError({ reason: "secret-store" })));
        yield* settings
          .updateSettings({ gerritConnections: { [installation]: config ?? null } })
          .pipe(
            Effect.mapError(() => new GerritConnectionError({ reason: "settings" })),
            Effect.tapError(() =>
              Option.isSome(previous)
                ? secrets
                    .set(name, previous.value)
                    .pipe(
                      Effect.mapError(() => new GerritConnectionError({ reason: "secret-store" })),
                    )
                : Effect.void,
            ),
          );
      }),
    );
    yield* invalidateGitHttpAuth;
  }, mutations.withPermits(1));
  const deliveryCheckout = Effect.fn("GerritService.deliveryCheckout")(function* (
    raw: typeof GerritDeliveryCheckoutInput.Type,
  ): Effect.fn.Return<GerritDeliveryCheckout, ReadError> {
    const input = yield* decodeDeliveryCheckoutInput(raw).pipe(
      Effect.mapError(() => new GerritConnectionError({ reason: "invalid-input" })),
    );
    const readGit = Effect.fn("GerritService.deliveryGit")(function* (args: ReadonlyArray<string>) {
      const result = yield* host.git
        .execute({
          cwd: input.cwd,
          operation: "GerritService.deliveryCheckout",
          args: ["--no-lazy-fetch", "--no-replace-objects", "--no-optional-locks", ...args],
          maxOutputBytes: 1024 * 1024,
          appendTruncationMarker: false,
        })
        .pipe(Effect.mapError(() => new GerritConnectionError({ reason: "local-read" })));
      if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated)
        return yield* new GerritConnectionError({ reason: "local-read" });
      return result.stdout;
    });
    const initialSettings = yield* getSettings;
    const connections = Object.values(initialSettings.gerritConnections);
    const configuration = yield* decodeRemoteConfig(gerritRemoteConfiguration(connections)).pipe(
      Effect.mapError(() => new GerritConnectionError({ reason: "invalid-input" })),
    );
    const discovery = yield* remotes
      .discover({ cwd: input.cwd, configuration })
      .pipe(Effect.mapError(() => new GerritConnectionError({ reason: "local-read" })));
    const repository =
      discovery.binding.kind === "bound"
        ? {
            installation: discovery.binding.scope.installation,
            project: discovery.binding.scope.project,
          }
        : discovery.binding.kind === "target-required"
          ? discovery.binding.repository
          : null;
    if (repository === null) {
      return discovery.binding.kind === "ambiguous"
        ? {
            kind: "blocked",
            detail:
              "More than one Gerrit repository is bound to this checkout. Remove the ambiguous remote binding first.",
          }
        : {
            kind: "not-bound",
            detail: "This checkout's origin does not resolve to a configured Gerrit project.",
          };
    }
    const root = (yield* readGit(["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "");
    if (root !== input.cwd)
      return {
        kind: "blocked",
        detail: "Run amend and upload from the checkout root.",
      };
    const localBranch = (yield* readGit(["rev-parse", "--abbrev-ref", "HEAD"])).replace(
      /\r?\n$/,
      "",
    );
    if (localBranch.length === 0 || localBranch === "HEAD")
      return {
        kind: "blocked",
        detail: "Detached HEAD: check out the branch that holds the commit first.",
      };
    if ((yield* readGit(["rev-parse", "--is-shallow-repository"])).trim() !== "false")
      return {
        kind: "blocked",
        detail: "A shallow checkout cannot prove the commit's parent or Change-Id history.",
      };
    const head = yield* decodeCommitOid((yield* readGit(["rev-parse", "HEAD"])).trim()).pipe(
      Effect.mapError(() => new GerritConnectionError({ reason: "local-read" })),
    );
    const commitObject = yield* readGit(["cat-file", "commit", head]);
    const separator = commitObject.indexOf("\n\n");
    if (separator < 0 || commitObject.includes("\0"))
      return { kind: "blocked", detail: "The selected commit object could not be read safely." };
    const message = commitObject.slice(separator + 2);
    const parents = commitObject
      .slice(0, separator)
      .split("\n")
      .filter((line) => line.startsWith("parent "));
    if (parents.length !== 1)
      return {
        kind: "blocked",
        detail: "The selected commit must have exactly one parent. Merge commits are not amended.",
      };
    const identity = commitIdentity(message);
    if (identity.kind !== "valid")
      return {
        kind: "blocked",
        detail:
          "The selected commit needs exactly one well-formed Change-Id trailer in its footer.",
      };
    const worktreeOutput = yield* readGit([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const worktree = parseWorktreeStatus(worktreeOutput);
    if (worktree === null)
      return {
        kind: "blocked",
        detail: "The working tree status could not be parsed safely.",
      };
    if (worktree.some((entry) => entry.unmerged))
      return {
        kind: "blocked",
        detail: "Resolve the current merge conflict before amending the commit.",
      };
    for (const name of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
    ]) {
      const path = (yield* readGit([
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        name,
      ])).trim();
      if (
        yield* fs
          .exists(path)
          .pipe(Effect.mapError(() => new GerritConnectionError({ reason: "local-read" })))
      )
        return {
          kind: "blocked",
          detail: "Finish or abort the in-progress git operation before amending.",
        };
    }
    const auth = yield* resolveAuth(repository.installation);
    yield* http.verify(auth);
    const visible = yield* http.findChangesByChangeId({
      ...auth,
      project: repository.project,
      changeId: identity.changeId,
    });
    const selectedBranch =
      input.targetBranch ??
      (discovery.binding.kind === "bound" ? discovery.binding.scope.branch : null);
    const changes =
      selectedBranch === null
        ? visible
        : visible.filter((change) => change.key.branch === selectedBranch);
    if (changes.length === 0) {
      const branch = selectedBranch;
      if (branch === null)
        return {
          kind: "blocked",
          detail: "Enter the Gerrit destination branch to create a new change.",
        };
      return {
        kind: "new-change",
        key: { ...repository, branch, changeId: identity.changeId },
        localBranch,
        head,
        subject: message.split("\n")[0] ?? "",
        files: worktree,
      };
    }
    if (changes.length > 1)
      return {
        kind: "blocked",
        detail:
          "More than one Gerrit change in this project has this Change-Id. The target is ambiguous.",
      };
    const change = changes[0];
    if (change === undefined)
      return { kind: "blocked", detail: "The Gerrit change could not be selected." };
    if (change.status !== "NEW")
      return {
        kind: "blocked",
        detail: `Change ${String(change.number)} is ${change.status} and cannot receive a patch set.`,
      };
    return {
      kind: "ready",
      change: {
        key: change.key,
        number: change.number,
        revision: { commit: change.currentRevision, patchSet: change.currentPatchSet },
      },
      localBranch,
      head,
      subject: change.subject,
      topic: change.topic ?? null,
      workInProgress: change.workInProgress,
      files: worktree.map((entry) => ({
        path: entry.path,
        status: entry.status,
        untracked: entry.untracked,
        unmerged: entry.unmerged,
      })),
    };
  });
  const readReview = Effect.fn("GerritService.readReview")(function* (input: GerritReviewInput) {
    return yield* http.review.readReview({
      ...(yield* resolveAuth(input.key.installation)),
      ...input,
    });
  }, mutations.withPermits(1));
  const readFiles = Effect.fn("GerritService.readFiles")(function* (
    input: typeof GerritFilesInput.Type,
  ) {
    return yield* http.review.readFiles({
      ...(yield* resolveAuth(input.key.installation)),
      ...input,
    });
  }, mutations.withPermits(1));
  const authorize = Effect.fn("GerritService.authorizeWrite")(function* (
    session: EnvironmentAuth.AuthenticatedSession,
  ) {
    return yield* appAuth
      .authorizeAppSession(session, ["source-control:write", "orchestration:read"])
      .pipe(Effect.mapError(() => new GerritWriteError({ reason: "authority" })));
  });
  const installHook = Effect.fn("GerritService.installHook")(function* (
    session: EnvironmentAuth.AuthenticatedSession,
    raw: typeof GerritHookInput.Type,
  ) {
    yield* authorize(session).pipe(
      Effect.mapError((cause) => new GerritHookError({ reason: "authority", cause })),
    );
    const diagnosis = yield* readHook(raw);
    if (diagnosis.state !== "missing") return yield* new GerritHookError({ reason: "conflict" });
    if (
      diagnosis.issues.some(
        (issue) =>
          issue === "link-trailer-generation-unsupported" ||
          issue === "change-id-generation-disabled",
      )
    )
      return yield* new GerritHookError({ reason: "unsafe" });
    const generation = (yield* getSettings).gerritCredentialGeneration;
    const environmentId = yield* environment.getEnvironmentId;
    return yield* hooks.installHook(
      raw.cwd,
      diagnosis,
      Effect.gen(function* () {
        const currentSettings = yield* getSettings.pipe(
          Effect.mapError((cause) => new GerritHookError({ reason: "stale", cause })),
        );
        if (
          environmentId !== (yield* environment.getEnvironmentId) ||
          generation !== currentSettings.gerritCredentialGeneration
        )
          return yield* new GerritHookError({ reason: "stale" });
        yield* authorize(session).pipe(
          Effect.mapError((cause) => new GerritHookError({ reason: "authority", cause })),
        );
      }),
    );
  }, mutations.withPermits(1));
  return GerritService.of({
    downloadCloneHook: Effect.fn("GerritService.downloadCloneHook")(function* (installation) {
      const validated = yield* validateInstallation(installation);
      const config = (yield* getSettings).gerritConnections[validated];
      if (config === undefined)
        return yield* new GerritConnectionError({ reason: "not-configured" });
      if (config.installation !== validated)
        return yield* new GerritConnectionError({ reason: "invalid-input" });
      return yield* http.downloadCloneHook(validated);
    }),
    readCloneConfig: Effect.fn("GerritService.readCloneConfig")(function* (installation) {
      const validated = yield* validateInstallation(installation);
      const config = (yield* getSettings).gerritConnections[validated];
      if (config === undefined) return null;
      if (config.installation !== validated)
        return yield* new GerritConnectionError({ reason: "invalid-input" });
      return config;
    }),
    bindVerifiedClone: Effect.fn("GerritService.bindVerifiedClone")(function* (input) {
      const installation = yield* validateInstallation(input.installation);
      const config = (yield* getSettings).gerritConnections[installation];
      if (config === undefined || config.installation !== installation)
        return yield* new GerritConnectionError({ reason: "not-configured" });
      const endpoint = resolveRemoteEndpoint(
        input.url,
        gerritRemoteConfiguration([{ ...config, bindings: [] }]),
      );
      if (
        endpoint.kind !== "candidate" ||
        !endpoint.repositories.some(
          (repository) =>
            repository.installation === installation && repository.project === input.project,
        )
      )
        return yield* new GerritConnectionError({ reason: "invalid-input" });
      const existing = config.bindings.filter((binding) => binding.url === input.url);
      if (existing.some((binding) => binding.project !== input.project))
        return yield* new GerritConnectionError({ reason: "invalid-input" });
      if (existing.length > 0) return;
      const updated = {
        ...config,
        bindings: [...config.bindings, { url: input.url, project: input.project }],
      };
      yield* decodeRemoteConfig({
        confirmedInstallations: [installation],
        exactBindings: updated.bindings.map((binding) => ({
          url: binding.url,
          repository: { installation, project: binding.project },
        })),
      }).pipe(Effect.mapError(() => new GerritConnectionError({ reason: "invalid-input" })));
      yield* settings
        .updateSettings({ gerritConnections: { [installation]: updated } })
        .pipe(Effect.mapError(() => new GerritConnectionError({ reason: "settings" })));
    }, mutations.withPermits(1)),
    resolveCloneAuth: resolveAuth,
    readHook,
    installHook,
    readReview,
    readFiles,
    listConnections,
    searchProjects,
    configureFromClient,
    removeCredentials,
    signingPassphraseStatus,
    setSigningPassphrase,
    deliveryCheckout,
    configureConnection,
    readConnection,
    testConnection,
    removeConnection,
    searchChanges,
    getChangeByNumber,
    getRelatedChanges,
  });
});

export const layer = Layer.effect(GerritService, make);
