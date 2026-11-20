import { GerritConnectionConfig, GerritInstallationId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const parseGerritConnectionConfig = Schema.decodeUnknownOption(GerritConnectionConfig);
const isInstallation = Schema.is(GerritInstallationId);

export function gerritTerminalGitCommandTemplate(
  installation: string,
  environmentId: string,
): string | null {
  if (
    !isInstallation(installation) ||
    !installation.startsWith("https://") ||
    !/^[A-Za-z0-9_-]+$/.test(environmentId)
  )
    return null;
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return [
    "# TEMPLATE: edit before running in the HTTPS checkout on the T3 server machine.",
    "# Replace the whole quoted '<T3-LAUNCHER>' token with the quoted absolute CLI path for that installation.",
    "# For a dev server, replace that whole token (including quotes) with: node '/absolute/server-checkout/apps/server/src/bin.ts'",
    "# Replace <T3-HOME> with the server's base directory (the parent of userdata).",
    "# A dev worktree normally uses /absolute/server-checkout/.t3; honor any --home-dir override.",
    `'<T3-LAUNCHER>' gerrit copy-terminal-credential --base-dir '<T3-HOME>' --installation ${quote(installation)} --environment-id ${quote(environmentId)}`,
  ].join("\n");
}

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
