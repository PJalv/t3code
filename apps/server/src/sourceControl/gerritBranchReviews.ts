import {
  GerritInstallationId,
  SourceControlProviderError,
  SourceControlProviderKind,
  type GerritConnectionConfig,
} from "@t3tools/contracts";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import type * as GerritBranchReviews from "@t3tools/source-control-gerrit/server/GerritBranchReviews";
import * as GerritHttp from "@t3tools/source-control-gerrit/server/GerritHttp";
import { gerritRemoteConfiguration } from "@t3tools/source-control-gerrit/server/remoteBinding";
import * as GerritRemotes from "@t3tools/source-control-gerrit/server/GerritRemotes";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GerritDriver from "@t3tools/source-control-gerrit/server/driver";

/**
 * The credential secret is stored under a digest of the installation URL, so the name is stable
 * and carries no part of the URL itself. Branch review reads the same secret the Gerrit service
 * writes, which is why this lives here rather than in either caller.
 */
export const credentialSecretName = (
  crypto: Digest.Digest["Service"],
  installation: GerritInstallationId,
) =>
  crypto
    .digest(Digest.sha256, new TextEncoder().encode(installation))
    .pipe(Effect.map((digest) => `gerrit-http-${Buffer.from(digest).toString("hex")}`));

// Decode with the same schema the Gerrit service encoded with: a second hand-written copy would
// drift from the stored shape.
const decodeCredentialValue = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GerritHttp.GerritHttpCredentialValue),
);

export type GerritConnectionConfigMap = Record<string, GerritConnectionConfig>;

export interface GerritBranchReviewResolverInput {
  readonly crypto: Digest.Digest["Service"];
  readonly readSettings: () => Effect.Effect<
    { readonly gerritConnections: GerritConnectionConfigMap },
    SourceControlProviderError
  >;
  readonly readSecret: (
    installation: GerritInstallationId,
  ) => Effect.Effect<Option.Option<Uint8Array>>;
  readonly discover: GerritRemotes.GerritRemotes["Service"]["discover"];
}

/** Only an unambiguous repository and verified upstream target identify a review scope. */
export const makeResolve = (
  input: GerritBranchReviewResolverInput,
): GerritBranchReviews.GerritBranchReviewsInput["resolve"] =>
  Effect.fn("GerritBranchReviews.resolve")(function* (cwd: string) {
    const settings = yield* input.readSettings();
    const configured = Object.values(settings.gerritConnections);
    if (configured.length === 0) return null;

    const discovery = yield* input
      .discover({ cwd, configuration: gerritRemoteConfiguration(configured) })
      .pipe(Effect.option, Effect.map(Option.getOrNull));
    if (discovery?.binding.kind !== "bound") return null;
    const { installation, project, branch } = discovery.binding.scope;
    const secret = yield* input.readSecret(installation);
    if (Option.isNone(secret)) return null;
    const credentials = yield* decodeCredentialValue(new TextDecoder().decode(secret.value)).pipe(
      Effect.option,
      Effect.map(Option.getOrNull),
    );
    if (credentials === null) return null;

    return {
      installation,
      project,
      branch,
      baseUrl: installation,
      credentials: Redacted.make(credentials) satisfies GerritHttp.GerritHttpCredentials,
    };
  }) as GerritBranchReviews.GerritBranchReviewsInput["resolve"];

/**
 * Builds the resolver from the services that actually hold credentials: the settings file names
 * the installations, the secret store holds the HTTP password, and the source control host runs
 * git. Kept as a layer of its own so the Gerrit driver can stay a plain driver.
 */
export const layer = Layer.effect(
  GerritDriver.GerritBranchReviewResolver,
  Effect.gen(function* () {
    const crypto = yield* Digest.Digest;
    const settings = yield* ServerSettings.ServerSettingsService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const remotes = yield* GerritRemotes.GerritRemotes.pipe(Effect.provide(GerritRemotes.layer));
    return makeResolve({
      crypto,
      readSettings: () =>
        settings.getSettings.pipe(
          Effect.map((current) => ({ gerritConnections: current.gerritConnections })),
          Effect.mapError(
            (cause) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("gerrit"),
                operation: "branchReviewScope",
                cwd: "",
                detail: "Gerrit connection settings could not be read.",
                cause,
              }),
          ),
        ),
      readSecret: (installation) =>
        credentialSecretName(crypto, installation).pipe(
          Effect.flatMap((name) => secrets.get(name)),
          Effect.orElseSucceed(() => Option.none<Uint8Array>()),
        ),
      discover: remotes.discover,
    });
  }),
);

/** Resolves the saved HTTP credential for the Gerrit server a pull request request names. */
export const layerGerritCredentialResolver = Layer.effect(
  GerritDriver.GerritPullRequestCredentialResolver,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const crypto = yield* Digest.Digest;
    const decode = Schema.decodeUnknownEffect(
      Schema.fromJsonString(GerritHttp.GerritHttpCredentialValue),
    );
    return Effect.fn("GerritPullRequestProvider.resolveCredential")(function* (server: string) {
      const failure = (cause?: unknown) =>
        new PullRequestProviderError({
          provider: SourceControlProviderKind.make("gerrit"),
          operation: "credentials",
          reason: "unauthenticated",
          detail: "Gerrit credentials are unavailable.",
          ...(cause === undefined ? {} : { cause }),
        });
      const current = yield* settings.getSettings.pipe(Effect.mapError(failure));
      const parsed = URL.parse(server.includes("://") ? server : `https://${server}`);
      const matches =
        parsed === null
          ? []
          : Object.values(current.gerritConnections).filter(
              (connection) =>
                new URL(connection.installation).host.toLowerCase() === parsed.host.toLowerCase(),
            );
      if (matches.length > 1)
        return yield* new PullRequestProviderError({
          provider: SourceControlProviderKind.make("gerrit"),
          operation: "credentials",
          reason: "failed",
          detail:
            "Multiple Gerrit servers are configured for this host. Configure a unique host and port for each server.",
        });
      if (matches.length === 0) return yield* failure();
      const connection = matches[0]!;
      const name = yield* credentialSecretName(crypto, connection.installation).pipe(
        Effect.mapError(failure),
      );
      const secret = yield* secrets.get(name).pipe(Effect.mapError(failure));
      if (Option.isNone(secret)) return yield* failure();
      const value = yield* decode(new TextDecoder().decode(secret.value)).pipe(
        Effect.mapError(failure),
      );
      const digest = yield* crypto
        .digest(Digest.sha256, secret.value)
        .pipe(Effect.mapError(failure));
      return {
        installation: connection.installation,
        credentials: Redacted.make(value),
        credentialFingerprint: Buffer.from(digest).toString("hex"),
        ...(connection.checksProfile ? { checksProfile: connection.checksProfile } : {}),
      };
    });
  }),
);

/** Gerrit's REST transport for the server's own Gerrit services; drivers build their own. */
export const layerGerritHttp = GerritHttp.layer.pipe(Layer.provide(FetchHttpClient.layer));
