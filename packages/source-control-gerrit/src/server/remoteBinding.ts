import {
  GerritInstallationId,
  GerritProjectName,
  GerritRepositoryScope,
  GerritTargetBranch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeProject = Schema.decodeSync(GerritProjectName);
const hasControl = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

function decodePath(value: string): string | undefined {
  try {
    const segments = value.split("/").map((segment) => {
      const decoded = decodeURIComponent(segment);
      if (
        !decoded ||
        decoded === "." ||
        decoded === ".." ||
        /[/\\\\]/.test(decoded) ||
        hasControl(decoded) ||
        encodeURIComponent(decoded) !== segment
      )
        throw new Error("Unsafe project segment");
      return decoded;
    });
    return segments.join("/");
  } catch {
    return undefined;
  }
}

function parseCloneUrl(value: string) {
  if (hasControl(value) || /[\s\\?#]/.test(value))
    return { kind: "rejected", reason: "unsupported" } as const;
  if (/^https?:\/\//i.test(value)) {
    const url = URL.parse(value);
    if (url === null) return { kind: "rejected", reason: "invalid" } as const;
    if (url.username !== "" || url.password !== "")
      return { kind: "rejected", reason: "credentials" } as const;
    const rawPath = /^https?:\/\/[^/]+\/(.*)$/i.exec(value)?.[1];
    const path = url.pathname.slice(1);
    if (rawPath === undefined || decodePath(rawPath) === undefined || rawPath !== path) {
      return { kind: "rejected", reason: "unsupported" } as const;
    }
    return { kind: "http", url, path } as const;
  }
  const ssh =
    /^ssh:\/\/(?:([A-Za-z0-9_][A-Za-z0-9_.-]*)@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?::([0-9]+))?\/(.+)$/.exec(
      value,
    );
  const scp = /^(?:([A-Za-z0-9_][A-Za-z0-9_.-]*)@)?([A-Za-z0-9][A-Za-z0-9.-]*):(.+)$/.exec(value);
  const path = ssh?.[4] ?? scp?.[3];
  // The host and port are kept because an SSH remote names only a clone host. Without them a
  // configured SSH host could never be matched to the installation it serves.
  const host = ssh?.[2] ?? scp?.[2];
  const port = ssh?.[3] === undefined ? undefined : Number(ssh[3]);
  const projectPath =
    path === undefined
      ? undefined
      : ssh
        ? decodePath(path)
        : path
              .split("/")
              .every(
                (segment) =>
                  segment !== "" &&
                  segment !== "." &&
                  segment !== ".." &&
                  encodeURIComponent(segment).replaceAll("%25", "%") === segment,
              )
          ? path
          : undefined;
  if (projectPath !== undefined && host !== undefined)
    return {
      kind: "ssh",
      path: projectPath,
      host,
      ...(port === undefined ? {} : { port }),
    } as const;
  if (value.includes("@")) return { kind: "rejected", reason: "credentials" } as const;
  return { kind: "rejected", reason: "unsupported" } as const;
}

export const GerritRemoteName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/),
);
export const GerritRemoteTargetBranch = GerritTargetBranch.check(
  Schema.makeFilter(
    (value) =>
      value !== "@" &&
      !value.startsWith("-") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !hasControl(value) &&
      !/[ ~^:?*[\\]/.test(value) &&
      !value.endsWith(".") &&
      value
        .split("/")
        .every(
          (segment) => segment !== "" && !segment.startsWith(".") && !segment.endsWith(".lock"),
        ),
  ),
);
export const GerritRemoteRepository = Schema.Struct({
  installation: GerritInstallationId,
  project: GerritProjectName,
});
export type GerritRemoteRepository = typeof GerritRemoteRepository.Type;

export const GerritRemoteConfiguration = Schema.Struct({
  confirmedInstallations: Schema.Array(GerritInstallationId),
  /**
   * SSH clone host for each confirmed installation, when its git operations go over SSH rather
   * than HTTPS. An SSH remote carries no installation URL, so without this a checkout cloned from
   * `gerrit-ssh.<host>:29418/<project>` matches no installation and never links its change.
   */
  sshHosts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        installation: GerritInstallationId,
        host: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
        port: Schema.optionalKey(Schema.Number),
      }),
    ),
  ),
  exactBindings: Schema.Array(
    Schema.Struct({
      url: Schema.String.check(
        Schema.makeFilter((value) => parseCloneUrl(value).kind !== "rejected"),
      ),
      repository: GerritRemoteRepository,
    }),
  ),
});
export type GerritRemoteConfiguration = typeof GerritRemoteConfiguration.Type;

/**
 * The settings shape one connection contributes to discovery. `sshHost` and `bindings` come
 * straight from the configured connection; a checkout whose remote names an SSH clone host can
 * only bind through `sshHosts`, since an SSH URL carries no installation URL to match.
 */
export function gerritRemoteConfiguration(
  connections: ReadonlyArray<{
    readonly installation: GerritInstallationId;
    readonly sshHost?: { readonly host: string; readonly port?: number };
    readonly bindings: ReadonlyArray<{ readonly url: string; readonly project: GerritProjectName }>;
  }>,
): GerritRemoteConfiguration {
  return {
    confirmedInstallations: connections.map((connection) => connection.installation),
    exactBindings: connections.flatMap((connection) =>
      connection.bindings.map((binding) => ({
        url: binding.url,
        repository: { installation: connection.installation, project: binding.project },
      })),
    ),
    sshHosts: connections.flatMap((connection) =>
      connection.sshHost === undefined
        ? []
        : [
            {
              installation: connection.installation,
              host: connection.sshHost.host,
              ...(connection.sshHost.port === undefined ? {} : { port: connection.sshHost.port }),
            },
          ],
    ),
  };
}

export const GerritRemoteEndpoint = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("candidate"),
    repositories: Schema.NonEmptyArray(GerritRemoteRepository),
  }),
  Schema.Struct({ kind: Schema.Literal("unknown"), transport: Schema.Literals(["http", "ssh"]) }),
  Schema.Struct({
    kind: Schema.Literal("rejected"),
    reason: Schema.Literals(["credentials", "unsupported", "invalid"]),
  }),
]);
export type GerritRemoteEndpoint = typeof GerritRemoteEndpoint.Type;

export const GerritRemote = Schema.Struct({
  name: GerritRemoteName,
  configured: Schema.Struct({
    fetch: Schema.Array(GerritRemoteEndpoint),
    push: Schema.Array(GerritRemoteEndpoint),
  }),
  effective: Schema.Struct({
    fetch: Schema.Array(GerritRemoteEndpoint),
    push: Schema.Array(GerritRemoteEndpoint),
  }),
});
export const GerritRemoteUpstream = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("detached") }),
  Schema.Struct({ kind: Schema.Literal("unsupported") }),
  Schema.Struct({
    kind: Schema.Literal("branch"),
    localBranch: GerritRemoteTargetBranch,
    remoteNames: Schema.Array(GerritRemoteName),
    mergeBranches: Schema.Array(GerritRemoteTargetBranch),
  }),
]);
export const GerritRemoteBinding = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("not-bound"),
    reason: Schema.Literals(["no-known-repository", "choice-unavailable"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("ambiguous"),
    repositories: Schema.NonEmptyArray(GerritRemoteRepository),
  }),
  Schema.Struct({ kind: Schema.Literal("target-required"), repository: GerritRemoteRepository }),
  Schema.Struct({ kind: Schema.Literal("bound"), scope: GerritRepositoryScope }),
]);
export type GerritRemoteBinding = typeof GerritRemoteBinding.Type;
export const GerritRemoteDiscovery = Schema.Struct({
  remotes: Schema.Array(GerritRemote),
  upstream: GerritRemoteUpstream,
  binding: GerritRemoteBinding,
});

function projectInterpretations(path: string, transport: "http" | "ssh") {
  const decoded = transport === "http" ? decodePath(path) : path;
  if (decoded === undefined) return [];
  const paths =
    transport === "http" && decoded.startsWith("a/") ? [decoded, decoded.slice(2)] : [decoded];
  return [
    ...new Set(
      paths.flatMap((project) =>
        project.endsWith(".git") ? [project, project.slice(0, -4)] : [project],
      ),
    ),
  ]
    .filter((project) => project.length > 0)
    .map((project) => decodeProject(project));
}

function uniqueRepositories(repositories: ReadonlyArray<GerritRemoteRepository>) {
  return [
    ...new Map(
      repositories.map((repository) => [
        JSON.stringify([repository.installation, repository.project]),
        repository,
      ]),
    ).values(),
  ];
}

export function resolveRemoteEndpoint(
  value: string,
  configuration: GerritRemoteConfiguration,
): GerritRemoteEndpoint {
  const parsed = parseCloneUrl(value);
  if (parsed.kind === "rejected") return parsed;
  const candidates: GerritRemoteRepository[] = [];
  if (parsed.kind === "http") {
    for (const installation of configuration.confirmedInstallations) {
      const base = new URL(installation);
      if (base.origin !== parsed.url.origin || !parsed.url.pathname.startsWith(base.pathname))
        continue;
      for (const project of projectInterpretations(
        parsed.url.pathname.slice(base.pathname.length),
        "http",
      )) {
        candidates.push({ installation, project });
      }
    }
  }
  // An SSH remote names a clone host, not an installation URL. Match it against the configured
  // SSH host so the same project binds without an exact-URL entry.
  if (parsed.kind === "ssh") {
    const host = parsed.host.toLowerCase();
    for (const candidate of configuration.sshHosts ?? []) {
      if (candidate.host.toLowerCase() !== host) continue;
      if ((candidate.port ?? 29418) !== (parsed.port ?? 22)) continue;
      for (const project of projectInterpretations(parsed.path, "ssh")) {
        candidates.push({ installation: candidate.installation, project });
      }
    }
  }
  const exact = configuration.exactBindings.filter(
    (binding) =>
      binding.url === value &&
      configuration.confirmedInstallations.includes(binding.repository.installation) &&
      (parsed.kind === "ssh"
        ? projectInterpretations(parsed.path, "ssh").includes(binding.repository.project)
        : candidates.some((candidate) => sameRepository(candidate, binding.repository))),
  );
  const repositories = uniqueRepositories(
    exact.length > 0 ? exact.map((binding) => binding.repository) : candidates,
  );
  const [first, ...rest] = repositories;
  return first === undefined
    ? { kind: "unknown", transport: parsed.kind }
    : { kind: "candidate", repositories: [first, ...rest] };
}

function sameRepository(left: GerritRemoteRepository, right: GerritRemoteRepository) {
  return left.installation === right.installation && left.project === right.project;
}

export function selectRemoteBinding(input: {
  readonly remotes: ReadonlyArray<typeof GerritRemote.Type>;
  readonly repository?: GerritRemoteRepository;
  readonly target?: typeof GerritRemoteTargetBranch.Type;
}): GerritRemoteBinding {
  const candidates = uniqueRepositories(
    input.remotes.flatMap((remote) =>
      [...remote.effective.fetch, ...remote.effective.push].flatMap((endpoint) =>
        endpoint.kind === "candidate" ? endpoint.repositories : [],
      ),
    ),
  );
  const repository = input.repository;
  const choices =
    repository === undefined
      ? candidates
      : candidates.filter((candidate) => sameRepository(candidate, repository));
  const [first, ...rest] = choices;
  if (first === undefined)
    return {
      kind: "not-bound",
      reason: input.repository === undefined ? "no-known-repository" : "choice-unavailable",
    };
  if (rest.length > 0) return { kind: "ambiguous", repositories: [first, ...rest] };
  return input.target === undefined
    ? { kind: "target-required", repository: first }
    : { kind: "bound", scope: { ...first, branch: input.target } };
}
