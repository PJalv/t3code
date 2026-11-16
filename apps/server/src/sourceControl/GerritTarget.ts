import { GerritChangeNumber, type GerritInstallationId } from "@t3tools/contracts";
import * as GerritHttp from "@t3tools/source-control-gerrit/server/GerritHttp";
import * as GerritRemotes from "@t3tools/source-control-gerrit/server/GerritRemotes";
import { gerritRemoteConfiguration } from "@t3tools/source-control-gerrit/server/remoteBinding";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { credentialSecretName } from "./gerritBranchReviews.ts";
import { changeFromUrl, uniqueChangeFromUrl } from "./gerritChangeUrl.ts";

export type TargetInput =
  | { readonly cwd: string; readonly number?: number; readonly url?: never }
  | { readonly url: string; readonly cwd?: string; readonly number?: never };
export interface Target {
  readonly server: string;
  readonly project: string;
  readonly number?: number;
  readonly branch?: string;
}

export class GerritTargetError extends Schema.TaggedError<GerritTargetError>()(
  "GerritTargetError",
  {
    reason: Schema.Literals([
      "settings",
      "remote-read",
      "remote-not-configured",
      "ambiguous-remote",
      "invalid-url",
      "ambiguous-server",
      "project-mismatch",
      "server-mismatch",
      "invalid-number",
      "credential-unavailable",
      "change-read",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "remote-not-configured":
        return "The checkout has no configured Gerrit remote. Configure its server and remote binding.";
      case "ambiguous-remote":
        return "The checkout matches multiple Gerrit repositories. Remove the ambiguity or configure an exact binding.";
      case "invalid-url":
        return "The change URL does not identify a change on a configured Gerrit server.";
      case "ambiguous-server":
        return "The change URL matches multiple configured Gerrit servers. Remove the overlapping server configuration.";
      case "project-mismatch":
        return "The change project does not match the checkout or URL project.";
      case "server-mismatch":
        return "The change server does not match the checkout's Gerrit server.";
      case "invalid-number":
        return "The Gerrit change number must be a positive integer.";
      case "credential-unavailable":
        return "The configured Gerrit server has no usable saved HTTP credential.";
      case "change-read":
        return "The Gerrit change could not be read.";
      case "remote-read":
        return "The checkout's Gerrit remotes could not be read.";
      case "settings":
        return "Gerrit connection settings could not be read.";
    }
  }
}

export class GerritTarget extends Context.Service<
  GerritTarget,
  {
    readonly resolve: (input: TargetInput) => Effect.Effect<Target, GerritTargetError>;
    readonly credentials: (
      server: string,
    ) => Effect.Effect<GerritHttp.GerritHttpCredentials, GerritTargetError>;
  }
>()("t3/sourceControl/GerritTarget") {}

const decodeCredential = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GerritHttp.GerritHttpCredentialValue),
);
const decodeNumber = Schema.decodeUnknownEffect(GerritChangeNumber);

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Digest.Digest;
  const remotes = yield* GerritRemotes.GerritRemotes;
  const http = yield* GerritHttp.GerritHttp;

  const connections = Effect.fn("GerritTarget.connections")(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new GerritTargetError({ reason: "settings", cause })),
    );
    return Object.values(current.gerritConnections);
  });
  const credentials = Effect.fn("GerritTarget.credentials")(function* (server: string) {
    const configured = yield* connections();
    const matches = configured.filter((connection) => connection.installation === server);
    if (matches.length !== 1)
      return yield* new GerritTargetError({
        reason: matches.length ? "ambiguous-server" : "credential-unavailable",
      });
    const name = yield* credentialSecretName(crypto, matches[0]!.installation).pipe(
      Effect.mapError(
        (cause) => new GerritTargetError({ reason: "credential-unavailable", cause }),
      ),
    );
    const secret = yield* secrets
      .get(name)
      .pipe(
        Effect.mapError(
          (cause) => new GerritTargetError({ reason: "credential-unavailable", cause }),
        ),
      );
    if (Option.isNone(secret))
      return yield* new GerritTargetError({ reason: "credential-unavailable" });
    const value = yield* decodeCredential(new TextDecoder().decode(secret.value)).pipe(
      Effect.mapError(
        (cause) => new GerritTargetError({ reason: "credential-unavailable", cause }),
      ),
    );
    return Redacted.make(value);
  });
  const resolve = Effect.fn("GerritTarget.resolve")(function* (input: TargetInput) {
    const configured = yield* connections();
    let checkout:
      | { installation: GerritInstallationId; project: string; branch?: string }
      | undefined;
    if (input.cwd !== undefined) {
      const discovery = yield* remotes
        .discover({ cwd: input.cwd, configuration: gerritRemoteConfiguration(configured) })
        .pipe(Effect.mapError((cause) => new GerritTargetError({ reason: "remote-read", cause })));
      const binding = discovery.binding;
      if (binding.kind === "ambiguous")
        return yield* new GerritTargetError({ reason: "ambiguous-remote" });
      if (binding.kind === "not-bound")
        return yield* new GerritTargetError({ reason: "remote-not-configured" });
      checkout = binding.kind === "bound" ? binding.scope : binding.repository;
    }
    let installation = checkout?.installation;
    let project = checkout?.project;
    let number = input.number;
    if (input.url !== undefined) {
      const servers = configured.map((connection) => connection.installation);
      const matches = servers.filter((server) => changeFromUrl(input.url!, server) !== null);
      const selected = uniqueChangeFromUrl(input.url, servers);
      if (selected === null)
        return yield* new GerritTargetError({
          reason:
            matches.length > 1 ||
            (matches.length === 1 &&
              servers.some(
                (server) =>
                  server !== matches[0] &&
                  (() => {
                    const url = URL.parse(input.url!);
                    const base = new URL(server);
                    const prefix = base.pathname.replace(/\/+$/, "");
                    return (
                      url !== null &&
                      url.origin === base.origin &&
                      (prefix === "" ||
                        url.pathname === prefix ||
                        url.pathname.startsWith(`${prefix}/`))
                    );
                  })(),
              ))
              ? "ambiguous-server"
              : "invalid-url",
        });
      if (checkout !== undefined && checkout.installation !== selected.installation)
        return yield* new GerritTargetError({ reason: "server-mismatch" });
      if (project !== undefined && selected.project !== undefined && project !== selected.project)
        return yield* new GerritTargetError({ reason: "project-mismatch" });
      installation = selected.installation as GerritInstallationId;
      project = selected.project ?? project;
      number = selected.number;
    }
    if (installation === undefined)
      return yield* new GerritTargetError({ reason: "remote-not-configured" });
    if (number !== undefined) {
      const validNumber = yield* decodeNumber(number).pipe(
        Effect.mapError((cause) => new GerritTargetError({ reason: "invalid-number", cause })),
      );
      const credential = yield* credentials(installation);
      const change = yield* http
        .getChangeByNumber({ installation, credentials: credential, number: validNumber })
        .pipe(Effect.mapError((cause) => new GerritTargetError({ reason: "change-read", cause })));
      if (project !== undefined && change.key.project !== project)
        return yield* new GerritTargetError({ reason: "project-mismatch" });
      return {
        server: installation,
        project: change.key.project,
        number: validNumber,
        branch: change.key.branch,
      };
    }
    if (project === undefined)
      return yield* new GerritTargetError({ reason: "remote-not-configured" });
    return {
      server: installation,
      project,
      ...(checkout?.branch === undefined ? {} : { branch: checkout.branch }),
    };
  });
  return GerritTarget.of({ resolve, credentials });
});

export const layer = Layer.effect(GerritTarget, make);
