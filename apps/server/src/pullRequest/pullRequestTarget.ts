import type { OrchestrationProjectShell, SourceControlProviderKind } from "@t3tools/contracts";
import { canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-definitions/registry";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { normalizeThreadPullRequestKey } from "../sourceControl/threadPullRequests.ts";
import { pullRequestSyncKey } from "./pullRequestSyncKey.ts";

export interface PullRequestTarget {
  readonly url?: string | undefined;
  readonly repository?: string | undefined;
  readonly number?: number | undefined;
  readonly host?: string | undefined;
}

export class PullRequestUrlInvalidError extends Schema.TaggedError<PullRequestUrlInvalidError>()(
  "PullRequestUrlInvalidError",
  {},
) {
  override get message(): string {
    return "This is not a recognised pull request URL. Pass repository and number instead.";
  }
}

export class PullRequestTargetIncompleteError extends Schema.TaggedError<PullRequestTargetIncompleteError>()(
  "PullRequestTargetIncompleteError",
  {},
) {
  override get message(): string {
    return "Pass either url or number.";
  }
}

export class PullRequestHostRequiredError extends Schema.TaggedError<PullRequestHostRequiredError>()(
  "PullRequestHostRequiredError",
  {},
) {
  override get message(): string {
    return "This thread's project has no recognised remote. Pass host or url.";
  }
}

export class PullRequestUrlUnavailableError extends Schema.TaggedError<PullRequestUrlUnavailableError>()(
  "PullRequestUrlUnavailableError",
  {},
) {
  override get message(): string {
    return "This thread's project is on a host with no known pull request URL shape. Pass url.";
  }
}

export class PullRequestRepositoryInvalidError extends Schema.TaggedError<PullRequestRepositoryInvalidError>()(
  "PullRequestRepositoryInvalidError",
  {},
) {
  override get message(): string {
    return "Pass repository as owner/repo, without the host.";
  }
}

export type PullRequestTargetError =
  | PullRequestUrlInvalidError
  | PullRequestTargetIncompleteError
  | PullRequestHostRequiredError
  | PullRequestUrlUnavailableError
  | PullRequestRepositoryInvalidError;

export interface ResolvedTarget {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

function projectHostAndProvider(project: OrchestrationProjectShell | undefined): {
  readonly host: string | null;
  readonly kind: SourceControlProviderKind | null;
} {
  const identity = project?.repositoryIdentity;
  const kind = identity?.provider ?? null;
  if (!identity || kind === null) return { host: null, kind: null };
  return {
    host: sourceControlDefinitions.changeRequestHost(identity, kind),
    kind,
  };
}

function projectRepository(project: OrchestrationProjectShell | undefined): string | undefined {
  const identity = project?.repositoryIdentity;
  if (!identity) return undefined;
  return (
    identity.displayName ||
    (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : undefined)
  );
}

export const resolveTarget = Effect.fn("PullRequestsToolkit.resolveTarget")(function* (
  input: PullRequestTarget,
  project: OrchestrationProjectShell | undefined,
) {
  if (input.url !== undefined) {
    const parsed = sourceControlDefinitions.parseChangeRequestUrl(input.url)?.link;
    // Gerrit's short `/c/<number>` routes omit the project; it is the project's repository.
    const repository = parsed?.repository || projectRepository(project);
    if (parsed === undefined || repository === undefined) {
      return yield* new PullRequestUrlInvalidError({});
    }
    return {
      ...normalizeThreadPullRequestKey({ ...parsed, repository }),
      url: canonicalizeGitCafePullRequestUrl(input.url),
    } satisfies ResolvedTarget;
  }
  // A bare number names a change request in the thread's own repository.
  const inputRepository = input.repository ?? projectRepository(project);
  if (inputRepository === undefined || input.number === undefined) {
    return yield* new PullRequestTargetIncompleteError({});
  }
  // Azure DevOps tools name the project's repository by its bare name, which no URL can be built
  // from, so it is read as the project's full repository path.
  const own =
    project?.repositoryIdentity == null || inputRepository.includes("/")
      ? null
      : pullRequestSyncKey(
          {
            projectId: project.id,
            host: input.host,
            repository: inputRepository,
            number: input.number,
          },
          project.repositoryIdentity,
        );
  const projectHost = projectHostAndProvider(project);
  const host = (own?.host ?? input.host ?? projectHost.host)?.toLowerCase();
  if (host === undefined) {
    return yield* new PullRequestHostRequiredError({});
  }
  const repository = (own?.repository ?? inputRepository).toLowerCase();
  // Without a URL, a public forge host says what shape its change request URLs take;
  // any other host is taken to run the project's own forge.
  const recognizedKind = sourceControlDefinitions.recognizeRemote(`https://${host}`)?.kind;
  const kind =
    sourceControlDefinitions.findByPublicHost(host)?.kind ??
    (recognizedKind === "gitcafe" ? recognizedKind : projectHost.kind);
  const definition = kind === null ? null : sourceControlDefinitions.get(kind);
  const url =
    definition?.changeRequestUrl({
      host,
      // Some hosts, such as Gerrit, have case-sensitive repository paths.
      repository: own?.repository ?? inputRepository,
      number: input.number,
      remoteUrl: project?.repositoryIdentity?.locator.remoteUrl,
    }) ?? null;
  if (url === null) {
    // A known forge returns no URL when the repository is not in its shape.
    return yield* definition === null || definition.kind === "unknown"
      ? new PullRequestUrlUnavailableError({})
      : new PullRequestRepositoryInvalidError({});
  }
  return {
    ...normalizeThreadPullRequestKey({ host, repository, number: input.number, url }),
    url: canonicalizeGitCafePullRequestUrl(url),
  } satisfies ResolvedTarget;
});
