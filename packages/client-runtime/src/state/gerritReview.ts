import { GerritConnectionConfig } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const parseGerritConnectionConfig = Schema.decodeUnknownOption(GerritConnectionConfig);

export function gerritCredentialSaveMode(input: {
  readonly installation: string | null;
  readonly connections: ReadonlyArray<{
    readonly config: { readonly installation: string };
    readonly credentialPresent: boolean;
  }>;
  readonly username: string;
  readonly token: string;
}): "keep" | "replace" | "invalid" {
  if (
    input.username.length === 0 &&
    input.token.length === 0 &&
    input.installation !== null &&
    input.connections.some(
      (connection) =>
        connection.config.installation === input.installation && connection.credentialPresent,
    )
  )
    return "keep";
  return input.username.trim().length > 0 && input.token.length > 0 ? "replace" : "invalid";
}

export function gerritConnectionConfigFromFields(
  fields: {
    readonly installation: string;
    readonly remote?: string;
    readonly project?: string;
    readonly sshHost?: string;
    readonly sshUsername?: string;
    readonly sshPort?: string;
    readonly checksProfile?: "checks-rest-v1-3.10" | "none";
  },
  connections: ReadonlyArray<{ readonly config: GerritConnectionConfig }>,
) {
  const installation = URL.parse(fields.installation.trim());
  if (installation === null) return parseGerritConnectionConfig(null);
  if (!installation.pathname.endsWith("/")) installation.pathname += "/";
  const existing = connections.find(
    (connection) => connection.config.installation === installation.href,
  );
  const rest = existing?.config.bindings.slice(1) ?? [];
  const remote = fields.remote?.trim() ?? "";
  const project = fields.project?.trim() ?? "";
  const bindings =
    fields.remote === undefined && fields.project === undefined
      ? (existing?.config.bindings ?? [])
      : remote || project
        ? [{ url: remote, project }, ...rest]
        : rest;
  const sshHost = fields.sshHost?.trim() ?? existing?.config.sshHost?.host ?? "";
  const sshUsername = fields.sshUsername?.trim() ?? existing?.config.sshHost?.username ?? "";
  const sshPort = fields.sshPort?.trim();
  if (sshHost.length === 0 && (sshUsername.length > 0 || (sshPort?.length ?? 0) > 0))
    return parseGerritConnectionConfig(null);
  return parseGerritConnectionConfig({
    installation: installation.href,
    authMode: "http-basic",
    // Only set when the checkout clones over SSH; an HTTPS checkout needs no host here.
    ...(sshHost.length === 0
      ? {}
      : {
          sshHost: {
            host: sshHost,
            ...(sshUsername.length === 0 ? {} : { username: sshUsername }),
            ...(sshPort === undefined
              ? sshHost === existing?.config.sshHost?.host &&
                existing.config.sshHost.port !== undefined
                ? { port: existing.config.sshHost.port }
                : {}
              : sshPort.length > 0
                ? { port: Number(sshPort) }
                : {}),
          },
        }),
    ...(fields.checksProfile === "none"
      ? {}
      : fields.checksProfile
        ? { checksProfile: fields.checksProfile }
        : existing?.config.checksProfile
          ? { checksProfile: existing.config.checksProfile }
          : {}),
    bindings,
  });
}
