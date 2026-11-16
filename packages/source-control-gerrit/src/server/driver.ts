// @effect-diagnostics effectFnOpportunity:off -- Driver callbacks follow the host interface.
import { SourceControlProviderError, SourceControlProviderKind } from "@t3tools/contracts";
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import { providerAuth } from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import { definition } from "../shared/definition.ts";
import * as GerritHttp from "./GerritHttp.ts";
import * as GerritBranchReviews from "./GerritBranchReviews.ts";
import * as GerritPullRequestProvider from "./GerritPullRequestProvider.ts";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import { gerritRemoteConfiguration, resolveRemoteEndpoint } from "./remoteBinding.ts";

const kind = SourceControlProviderKind.make("gerrit");

export interface GerritDriverOptions {
  readonly branchReviews?: Omit<GerritBranchReviews.GerritBranchReviewsInput, "http">;
  /**
   * A resolver already bound to the server's settings and secret store. The driver cannot build
   * one itself: credentials live behind services the driver does not require.
   */
  readonly resolveBranchReviewScope?: GerritBranchReviews.GerritBranchReviewsInput["resolve"];
}

export const makeDriver = (options: GerritDriverOptions = {}) =>
  defineSourceControlDriver({
    kind,
    definition,
    make: Effect.gen(function* () {
      const host = yield* SourceControlHost.SourceControlHost;
      const api = yield* GerritHttp.GerritHttp;
      const injected = yield* Effect.serviceOption(GerritBranchReviewResolver);
      const credentialResolver = yield* Effect.serviceOption(GerritPullRequestCredentialResolver);
      const pullRequestApi = yield* GerritPullRequestProvider.make(
        Option.isSome(credentialResolver)
          ? credentialResolver.value
          : () =>
              Effect.fail(
                new PullRequestProviderError({
                  provider: kind,
                  operation: "credentials",
                  reason: "unauthenticated",
                  detail: "Gerrit credentials are unavailable.",
                }),
              ),
      );
      const resolveScope =
        options.resolveBranchReviewScope ?? (Option.isSome(injected) ? injected.value : undefined);
      const reviews =
        resolveScope === undefined
          ? undefined
          : GerritBranchReviews.makeBranchReviews({
              http: api,
              ...options.branchReviews,
              resolve: resolveScope,
              git:
                options.branchReviews?.git ??
                ((cwd, args) =>
                  host.process
                    .run({ cwd, operation: "branchReviewScope", command: "git", args })
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new SourceControlProviderError({
                            provider: kind,
                            operation: "git",
                            cwd,
                            detail: `git ${args.join(" ")} failed.`,
                            cause,
                          }),
                      ),
                      Effect.map((output) => output.stdout),
                    )),
            } as GerritBranchReviews.GerritBranchReviewsInput);
      const unsupported = (operation: string, cwd: string) =>
        new SourceControlProviderError({
          provider: kind,
          operation,
          cwd,
          detail: "Gerrit branch reviews are not supported without a scope resolver.",
        });
      return {
        sourceControl: SourceControlProvider.SourceControlProvider.of({
          kind,
          refineRepositoryIdentity: Effect.fn(
            "GerritSourceControlProvider.refineRepositoryIdentity",
          )(function* ({ identity, resolveContext }) {
            if (!identity.rootPath) return identity;
            const settings = yield* host.settings.get.pipe(Effect.orElseSucceed(() => null));
            if (settings === null) return identity;
            const endpoint = resolveRemoteEndpoint(
              identity.locator.remoteUrl,
              gerritRemoteConfiguration(Object.values(settings.gerritConnections)),
            );
            if (endpoint.kind !== "candidate") return identity;
            // Host-only PR routing cannot distinguish servers sharing a host and port. Keep a
            // Gerrit identity in that case so credential resolution reports the ambiguity.
            const hosts = new Set(
              endpoint.repositories.map(({ installation }) => new URL(installation).host),
            );
            const installations = new Set(
              endpoint.repositories.map(({ installation }) => installation),
            );
            const installation =
              hosts.size === 1 && installations.size > 1
                ? [...endpoint.repositories].sort(
                    (a, b) => b.installation.length - a.installation.length,
                  )[0]?.installation
                : undefined;
            const lookup = resolveContext({
              cwd: identity.rootPath,
              context: {
                provider: {
                  kind: SourceControlProviderKind.make("unknown"),
                  name: "Unknown",
                  baseUrl: "",
                },
                remoteName: identity.locator.remoteName,
                remoteUrl: identity.locator.remoteUrl,
              },
            });
            const context = yield* installation === undefined
              ? lookup
              : lookup.pipe(Effect.orElseSucceed(() => null));
            const baseUrl =
              context?.provider.kind === "gerrit" ? context.provider.baseUrl : installation;
            if (baseUrl === undefined) return identity;
            const candidates = endpoint.repositories.filter(
              (repository) => repository.installation === baseUrl,
            );
            const remote = URL.parse(identity.locator.remoteUrl);
            const base = URL.parse(baseUrl);
            if (base === null) return identity;
            const hasAuthPrefix =
              remote !== null &&
              (remote.protocol === "http:" || remote.protocol === "https:") &&
              remote.pathname.slice(base.pathname.length).startsWith("a/");
            const preferredPath = hasAuthPrefix
              ? remote.pathname
                  .slice(base.pathname.length + 2)
                  .split("/")
                  .map(decodeURIComponent)
                  .join("/")
                  .replace(/\.git$/, "")
              : undefined;
            const selected =
              candidates.length > 1 && preferredPath !== undefined
                ? (candidates.find((candidate) => candidate.project === preferredPath) ??
                  candidates[0])
                : (candidates.find((candidate) => !candidate.project.endsWith(".git")) ??
                  candidates[0]);
            if (selected === undefined) return identity;
            const project = selected.project;
            return {
              ...identity,
              provider: kind,
              canonicalKey: `${base.host.toLowerCase()}/${project.toLowerCase()}`,
              displayName: project,
              owner: project.split("/")[0] ?? project,
              name: project.split("/").at(-1) ?? project,
              webUrl: `${baseUrl.replace(/\/+$/, "")}/${project}`,
            };
          }),
          ...reviews,
          listChangeRequests: (input) =>
            reviews
              ? reviews.listChangeRequests(input)
              : unsupported("listChangeRequests", input.cwd),
          getChangeRequest: (input) =>
            reviews ? reviews.getChangeRequest(input) : unsupported("getChangeRequest", input.cwd),
          createChangeRequest: (input) =>
            reviews
              ? reviews.createChangeRequest(input)
              : unsupported("createChangeRequest", input.cwd),
          checkoutChangeRequest: (input) =>
            reviews
              ? reviews.checkoutChangeRequest(input)
              : unsupported("checkoutChangeRequest", input.cwd),

          // The add-project palette offers a clone for every listed provider. Both URLs come from
          // the configured installation; the HTTP one is anonymous, since clone URLs are stored.
          getRepositoryCloneUrls: ({ cwd, repository }) =>
            host.settings.get.pipe(
              Effect.mapError(
                () =>
                  new SourceControlProviderError({
                    provider: kind,
                    operation: "getRepositoryCloneUrls",
                    cwd,
                    detail: "Gerrit connection settings could not be read.",
                  }),
              ),
              Effect.flatMap((settings) => {
                const project = repository.trim().replace(/^\/+|\/+$/g, "");
                const connections = Object.values(settings.gerritConnections);
                const bound = connections.find((candidate) =>
                  candidate.bindings.some((binding) => binding.project === project),
                );
                // Bindings only record existing checkouts, so a new connection has none. Use the
                // only configured installation, and stay ambiguous when there are several.
                const connection = bound ?? (connections.length === 1 ? connections[0] : undefined);
                const installation = connection?.installation;
                const parsed = installation === undefined ? null : URL.parse(installation);
                if (connection === undefined || installation === undefined || parsed === null)
                  return new SourceControlProviderError({
                    provider: kind,
                    operation: "getRepositoryCloneUrls",
                    cwd,
                    detail:
                      project.length === 0
                        ? "Enter a Gerrit project name to look it up."
                        : connections.length > 1
                          ? `More than one Gerrit installation is configured and none binds ${project}. Add a remote binding in Source Control settings so the project resolves to one installation.`
                          : `No Gerrit connection binds the project ${project}. Add its remote binding in Source Control settings.`,
                  });
                const origin = `${parsed.protocol}//${parsed.host}`;
                const encodeProject = project
                  .split("/")
                  .map((segment) => encodeURIComponent(segment))
                  .join("/");
                // No `/a/` prefix: it forces credentials, and clone URLs are stored in `.git/config`.
                // SSH often lives on another hostname than HTTP, so prefer the configured sshHost.
                const sshHostname = connection.sshHost?.host ?? parsed.hostname;
                const sshPort = connection.sshHost?.port ?? 29418;
                return Effect.succeed({
                  nameWithOwner: project,
                  url: `${origin}/${encodeProject}`,
                  sshUrl: `ssh://${sshHostname}:${sshPort}/${encodeProject}`,
                  // Anonymous HTTPS fails on servers that require authentication, and the generic
                  // clone path cannot prompt, so a configured sshHost makes SSH the default.
                  ...(connection.sshHost === undefined || connection.sshHost.host.length === 0
                    ? {}
                    : { preferredTransport: "ssh" as const }),
                });
              }),
            ),
          createRepository: ({ cwd }) =>
            new SourceControlProviderError({
              provider: kind,
              operation: "createRepository",
              cwd,
              detail: "Creating Gerrit projects is not supported.",
            }),
          getDefaultBranch: () => Effect.succeed(null),
        }),
        discovery: {
          kind,
          type: "api" as const,
          label: "Gerrit",
          installHint: "Configure an installation and HTTP credentials in Source Control settings.",
          probeAuth: host.settings.get.pipe(
            Effect.map((settings) =>
              providerAuth({
                status: "unknown",
                detail:
                  Object.keys(settings.gerritConnections).length > 0
                    ? "Configured. Test the connection to verify the current account."
                    : "No Gerrit connection configured.",
              }),
            ),
            Effect.orElseSucceed(() =>
              providerAuth({
                status: "unknown",
                detail: "Connection settings could not be read.",
              }),
            ),
          ),
        },
        pullRequests: pullRequestApi,
      };
    }).pipe(Effect.provide(GerritHttp.layer)),
  });

export const driver = makeDriver();

/**
 * Branch review linkage needs the server's settings and secret store, which the driver itself does
 * not require. A host that does not provide it cannot use Gerrit branch review operations.
 */
export class GerritPullRequestCredentialResolver extends Context.Service<
  GerritPullRequestCredentialResolver,
  GerritPullRequestProvider.GerritCredentialResolver
>()("@t3tools/source-control-gerrit/server/driver/GerritPullRequestCredentialResolver") {}

export class GerritBranchReviewResolver extends Context.Service<
  GerritBranchReviewResolver,
  GerritBranchReviews.GerritBranchReviewsInput["resolve"]
>()("@t3tools/source-control-gerrit/server/driver/GerritBranchReviewResolver") {}
