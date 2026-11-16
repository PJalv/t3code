import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { GerritInstallationId, GerritProjectName } from "@t3tools/contracts";
import {
  GerritRemoteConfiguration,
  GerritRemoteDiscovery,
  GerritRemoteRepository,
  GerritRemoteTargetBranch,
  gerritRemoteConfiguration,
  resolveRemoteEndpoint,
  selectRemoteBinding,
} from "./remoteBinding.ts";

const decodeInstallationId = Schema.decodeSync(GerritInstallationId);
const decodeProjectName = Schema.decodeSync(GerritProjectName);

const decodeConfiguration = Schema.decodeSync(GerritRemoteConfiguration);
const decodeDiscovery = Schema.decodeSync(GerritRemoteDiscovery);
const decodeTarget = Schema.decodeSync(GerritRemoteTargetBranch);
const decodeRepository = Schema.decodeSync(GerritRemoteRepository);
const isTarget = Schema.is(GerritRemoteTargetBranch);
const isConfiguration = Schema.is(GerritRemoteConfiguration);
const configuration = decodeConfiguration({
  confirmedInstallations: ["https://review.example:8443/Review/"],
  exactBindings: [],
});
const installation = configuration.confirmedInstallations[0];
if (installation === undefined) throw new Error("Expected confirmed fixture installation.");

describe("native remote binding policy", () => {
  it.each(["Single", "Team/Repo", "Team/Repo.git", "a/Team/Repo", "a/Team/Repo.git"])(
    "preserves exact project interpretations for %s",
    (path) => {
      const result = resolveRemoteEndpoint(
        `https://review.example:8443/Review/${path}`,
        configuration,
      );
      const expected =
        path === "Single"
          ? ["Single"]
          : path === "Team/Repo"
            ? ["Team/Repo"]
            : path === "Team/Repo.git"
              ? ["Team/Repo.git", "Team/Repo"]
              : path === "a/Team/Repo"
                ? ["a/Team/Repo", "Team/Repo"]
                : ["a/Team/Repo.git", "a/Team/Repo", "Team/Repo.git", "Team/Repo"];
      expect(result).toEqual({
        kind: "candidate",
        repositories: expected.map((project) => ({ installation, project })),
      });
    },
  );

  // An SSH remote names only a clone host. Configuring that host is what lets an SSH checkout
  // bind at all, so these pin both the configured and unconfigured answers.
  it.each([
    ["ssh://git@review.example:29418/Team/Repo", 29418],
    ["git@review.example:Team/Repo", 22],
  ])("binds %s when its clone host is configured", (url, port) => {
    expect(
      resolveRemoteEndpoint(url, {
        ...configuration,
        sshHosts: [{ installation, host: "review.example", port }],
      }),
    ).toEqual({ kind: "candidate", repositories: [{ installation, project: "Team/Repo" }] });
  });

  it.each([
    ["ssh://git@review.example/Team/Repo", undefined, "unknown"],
    ["git@review.example:Team/Repo", 29418, "unknown"],
    ["ssh://git@review.example:2222/Team/Repo", undefined, "unknown"],
    ["ssh://git@review.example:29418/Team/Repo", undefined, "candidate"],
    ["ssh://git@review.example/Team/Repo", 22, "candidate"],
  ] as const)("matches effective SSH port for %s", (url, port, kind) => {
    expect(
      resolveRemoteEndpoint(url, {
        ...configuration,
        sshHosts: [
          { installation, host: "review.example", ...(port === undefined ? {} : { port }) },
        ],
      }).kind,
    ).toBe(kind);
  });

  it.each([
    "https://review.example:8443/Review/Team/My%20Repo",
    "ssh://git@review.example:29418/Team/My%20Repo",
  ])("decodes canonical project segments in %s", (url) => {
    expect(
      resolveRemoteEndpoint(url, {
        ...configuration,
        sshHosts: [{ installation, host: "review.example" }],
      }),
    ).toEqual({ kind: "candidate", repositories: [{ installation, project: "Team/My Repo" }] });
  });

  it("keeps SCP percent escapes literal when matching configured hosts and exact bindings", () => {
    const url = "git@review.example:Team/My%20Repo";
    const repository = decodeRepository({ installation, project: "Team/My%20Repo" });
    const configured = decodeConfiguration({
      ...configuration,
      sshHosts: [{ installation, host: "review.example", port: 22 }],
      exactBindings: [{ url, repository }],
    });
    expect(resolveRemoteEndpoint(url, configured)).toEqual({
      kind: "candidate",
      repositories: [repository],
    });
    expect(resolveRemoteEndpoint(url, { ...configured, exactBindings: [] })).toEqual({
      kind: "candidate",
      repositories: [repository],
    });
    expect(
      resolveRemoteEndpoint(url, {
        ...configured,
        sshHosts: [],
        exactBindings: [
          { url, repository: decodeRepository({ installation, project: "Team/My Repo" }) },
        ],
      }),
    ).toEqual({ kind: "unknown", transport: "ssh" });
    expect(resolveRemoteEndpoint("git@review.example:Team/%2F", configured)).toEqual({
      kind: "candidate",
      repositories: [{ installation, project: "Team/%2F" }],
    });
    expect(resolveRemoteEndpoint("ssh://git@review.example:22/Team/My%20Repo", configured)).toEqual(
      {
        kind: "candidate",
        repositories: [{ installation, project: "Team/My Repo" }],
      },
    );
  });

  it.each(["%2F", "%5C", "%2E%2E", "%2e%2e", "%41", "%ZZ"])(
    "rejects unsafe or noncanonical encoded segment %s",
    (segment) => {
      for (const url of [
        `https://review.example:8443/Review/Team/${segment}`,
        `ssh://git@review.example:29418/Team/${segment}`,
      ])
        expect(resolveRemoteEndpoint(url, configuration).kind).toBe("rejected");
    },
  );

  it("does not bind an SSH host that serves a different installation", () => {
    expect(
      resolveRemoteEndpoint("ssh://git@review.example:29418/Team/Repo", {
        ...configuration,
        sshHosts: [{ installation, host: "elsewhere.example", port: 29418 }],
      }).kind,
    ).toBe("unknown");
  });

  it("does not bind a different SSH port for the same host", () => {
    expect(
      resolveRemoteEndpoint("ssh://git@review.example:2222/Team/Repo", {
        ...configuration,
        sshHosts: [{ installation, host: "review.example", port: 29418 }],
      }).kind,
    ).toBe("unknown");
  });

  it.each([
    "http://review.example:8443/Review/Team/Repo",
    "https://review.example/Review/Team/Repo",
    "https://review.example:8444/Review/Team/Repo",
    "https://review.example:8443/review/Team/Repo",
    "https://review.example:8443/Reviewer/Team/Repo",
    "https://other.example:8443/Review/Team/Repo",
    "ssh://git@review.example:29418/Team/Repo",
    "git@review.example:Team/Repo",
  ])("does not verify an unknown installation from %s", (url) => {
    expect(resolveRemoteEndpoint(url, configuration).kind).toBe("unknown");
  });

  it.each([
    "https://review.example:8443/Review/../Team/Repo",
    "https://review.example:8443/Review/%2e%2e/Team/Repo",
    "https://review.example:8443/Review/Team%2fRepo",
    "https://review.example:8443/Review/Team//Repo",
    "https://review.example:8443/Review/Team/Repo/",
    "https://review.example:8443/Review/Team\\Repo",
    "https://review.example:8443/Review/Team/Repo?token=secret",
    "https://user:secret@review.example:8443/Review/Team/Repo",
    "https://secret@review.example:8443/Review/Team/Repo",
    "ssh://user:secret@review.example/Team/Repo",
    "ext::helper secret",
    "file:///secret",
  ])("rejects ambiguous or credential-bearing syntax without retaining %s", (url) => {
    const result = resolveRemoteEndpoint(url, configuration);
    expect(result.kind).toBe("rejected");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain(url);
  });

  it("allows exact binding to select a literal .git project and authenticated-prefix interpretation", () => {
    const url = "https://review.example:8443/Review/a/Team/Repo.git";
    const repository = { installation, project: "Team/Repo.git" };
    const exact = decodeConfiguration({
      ...configuration,
      exactBindings: [{ url, repository }],
    });
    expect(resolveRemoteEndpoint(url, exact)).toEqual({
      kind: "candidate",
      repositories: [repository],
    });
    const invalid = decodeConfiguration({
      ...configuration,
      exactBindings: [{ url, repository: { installation, project: "Wrong" } }],
    });
    expect(resolveRemoteEndpoint(url, invalid)).toEqual(resolveRemoteEndpoint(url, configuration));
  });

  it("retains overlapping installation mounts including /a/ until exact choice", () => {
    const overlapping = decodeConfiguration({
      confirmedInstallations: ["https://review.example/", "https://review.example/a/"],
      exactBindings: [],
    });
    expect(resolveRemoteEndpoint("https://review.example/a/Single", overlapping)).toEqual({
      kind: "candidate",
      repositories: [
        { installation: "https://review.example/", project: "a/Single" },
        { installation: "https://review.example/", project: "Single" },
        { installation: "https://review.example/a/", project: "Single" },
      ],
    });
  });

  it("does not allow an exact SSH binding to confirm an unknown installation or invent a project", () => {
    const url = "git@fixture-alias:Single";
    for (const repository of [
      { installation: "https://unconfirmed.example/", project: "Single" },
      { installation, project: "Wrong" },
    ]) {
      const exact = decodeConfiguration({
        ...configuration,
        exactBindings: [{ url, repository }],
      });
      expect(resolveRemoteEndpoint(url, exact)).toEqual({ kind: "unknown", transport: "ssh" });
    }
  });

  it.each([
    "git@review-alias:a/Team/Repo",
    "ssh://git@review-alias:29418/a/Team/Repo",
    "git@review-alias:a/Team/Repo.git",
    "ssh://git@review-alias:29418/a/Team/Repo.git",
  ])("does not strip an HTTP authentication prefix from SSH project %s", (url) => {
    const exact = decodeConfiguration({
      ...configuration,
      exactBindings: [{ url, repository: { installation, project: "Team/Repo" } }],
    });
    expect(resolveRemoteEndpoint(url, exact)).toEqual({ kind: "unknown", transport: "ssh" });
  });

  it.each([
    "git@review-alias:a/Team/Repo",
    "ssh://git@review-alias:29418/a/Team/Repo",
    "git@review-alias:a/Team/Repo.git",
    "ssh://git@review-alias:29418/a/Team/Repo.git",
  ])("preserves literal SSH a/ projects and optional .git suffix matching for %s", (url) => {
    const repository = decodeRepository({ installation, project: "a/Team/Repo" });
    const exact = decodeConfiguration({
      ...configuration,
      exactBindings: [{ url, repository }],
    });
    expect(resolveRemoteEndpoint(url, exact)).toEqual({
      kind: "candidate",
      repositories: [repository],
    });
  });

  it.each([
    "ssh://alice@review-alias:29418/Team/Repo",
    "alice@review-alias:Team/Repo",
    "ssh://john.doe@review-alias:29418/Team/Repo",
    "john.doe@review-alias:Team/Repo",
  ])("accepts ordinary SSH usernames only with a complete exact binding for %s", (url) => {
    const repository = decodeRepository({ installation, project: "Team/Repo" });
    const exact = decodeConfiguration({
      ...configuration,
      exactBindings: [{ url, repository }],
    });
    expect(resolveRemoteEndpoint(url, configuration)).toEqual({
      kind: "unknown",
      transport: "ssh",
    });
    expect(resolveRemoteEndpoint(url, exact)).toEqual({
      kind: "candidate",
      repositories: [repository],
    });
    expect(resolveRemoteEndpoint(url.replace(/(?:alice|john\.doe)@/, "git@"), exact)).toEqual({
      kind: "unknown",
      transport: "ssh",
    });
  });

  it.each([
    "ssh://alice:secret@review-alias:29418/Team/Repo",
    "alice:secret@review-alias:Team/Repo",
    "ssh://alice:@review-alias/Team/Repo",
    "alice:@review-alias:Team/Repo",
    "ssh://alice\t@review-alias/Team/Repo",
    "alice@review-alias:Team/Repo\u007f",
    "ssh://alice@review-alias/Team/Repo?token=secret",
    "alice@review-alias:Team/Repo#secret",
    "ssh://ali%63e@review-alias/Team/Repo",
    "ssh://álîce@review-alias/Team/Repo",
    "ssh://-alice@review-alias/Team/Repo",
    "https://alice@review.example:8443/Review/Team/Repo",
    "https://john.doe:secret@review.example:8443/Review/Team/Repo",
  ])("rejects unsafe account syntax in both schema and endpoint resolution for %s", (url) => {
    const repository = decodeRepository({ installation, project: "Team/Repo" });
    expect(
      isConfiguration({
        ...configuration,
        exactBindings: [{ url, repository }],
      }),
    ).toBe(false);
    const result = resolveRemoteEndpoint(url, configuration);
    expect(result.kind).toBe("rejected");
    expect(JSON.stringify(result)).not.toContain(url);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("alice");
    expect(JSON.stringify(result)).not.toContain("john.doe");
  });

  it.each([false, true])(
    "deduplicates repository fields regardless of property order with explicit choice %s",
    (explicit) => {
      const repository = decodeRepository({ installation, project: "Team/Repo" });
      const url = "git@review-alias:Team/Repo";
      const assembled = {
        confirmedInstallations: [installation],
        exactBindings: [
          {
            url,
            repository: { project: repository.project, installation: repository.installation },
          },
        ],
      } satisfies GerritRemoteConfiguration;
      expect(isConfiguration(assembled)).toBe(true);
      const fetch = resolveRemoteEndpoint(
        "https://review.example:8443/Review/Team/Repo",
        assembled,
      );
      const push = resolveRemoteEndpoint(url, assembled);
      const remotes = [
        {
          name: "review",
          configured: { fetch: [fetch], push: [push] },
          effective: { fetch: [fetch], push: [push] },
        },
      ];
      const target = decodeTarget("Release/Next");
      expect(selectRemoteBinding({ remotes, target, ...(explicit ? { repository } : {}) })).toEqual(
        {
          kind: "bound",
          scope: { ...repository, branch: target },
        },
      );
    },
  );

  it("deduplicates the same scope but requires an explicit target and rejects unavailable choices", () => {
    const endpoint = resolveRemoteEndpoint(
      "https://review.example:8443/Review/Team/Repo",
      configuration,
    );
    const remotes = [
      {
        name: "review",
        configured: { fetch: [endpoint], push: [] },
        effective: { fetch: [endpoint], push: [endpoint] },
      },
    ];
    expect(selectRemoteBinding({ remotes })).toEqual({
      kind: "target-required",
      repository: { installation, project: "Team/Repo" },
    });
    const target = decodeTarget("Release/Next");
    const result = decodeDiscovery({
      remotes,
      upstream: { kind: "detached" },
      binding: selectRemoteBinding({ remotes, target }),
    });
    expect(result.binding).toEqual({
      kind: "bound",
      scope: { installation, project: "Team/Repo", branch: "Release/Next" },
    });
    const repository = decodeRepository({ installation, project: "Other" });
    expect(selectRemoteBinding({ remotes, repository, target })).toEqual({
      kind: "not-bound",
      reason: "choice-unavailable",
    });
  });

  it("builds the discovery configuration with the connections' ssh hosts", () => {
    const fixtureInstallation = decodeInstallationId("http://127.0.0.1:46139/");
    const productionInstallation = decodeInstallationId("https://gerrit.example.test/");
    const fixture = gerritRemoteConfiguration([
      {
        installation: fixtureInstallation,
        bindings: [
          {
            url: "http://127.0.0.1:46139/a/native-proof-01",
            project: decodeProjectName("native-proof-01"),
          },
        ],
      },
      {
        installation: productionInstallation,
        sshHost: { host: "gerrit-ssh.example.test" },
        bindings: [],
      },
    ]);
    expect(fixture.confirmedInstallations).toEqual([
      "http://127.0.0.1:46139/",
      "https://gerrit.example.test/",
    ]);
    expect(fixture.exactBindings).toEqual([
      {
        url: "http://127.0.0.1:46139/a/native-proof-01",
        repository: { installation: "http://127.0.0.1:46139/", project: "native-proof-01" },
      },
    ]);
    expect(fixture.sshHosts).toEqual([
      { installation: "https://gerrit.example.test/", host: "gerrit-ssh.example.test" },
    ]);
    const configuredPort = gerritRemoteConfiguration([
      {
        installation: productionInstallation,
        sshHost: { host: "gerrit-ssh.example.test", port: 29418 },
        bindings: [],
      },
    ]);
    expect(configuredPort.sshHosts).toEqual([
      {
        installation: "https://gerrit.example.test/",
        host: "gerrit-ssh.example.test",
        port: 29418,
      },
    ]);
    const withoutSshHost = gerritRemoteConfiguration([
      { installation: productionInstallation, bindings: [] },
    ]);
    expect(withoutSshHost.sshHosts).toEqual([]);
  });

  it("binds an SSH checkout through its configured ssh host without an exact binding", () => {
    // Real shape of the production failure: the checkout's remote is
    // ssh://<user>@gerrit-ssh.<host>:29418/<project>, the connection has an sshHost and zero
    // bindings. GerritAgentAccess.resolve built this configuration without sshHosts once, so
    // every MCP read and link for such a checkout denied with reason "authority".
    const configuration = gerritRemoteConfiguration([
      {
        installation: decodeInstallationId("http://127.0.0.1:46139/"),
        bindings: [
          {
            url: "http://127.0.0.1:46139/a/native-proof-01",
            project: decodeProjectName("native-proof-01"),
          },
        ],
      },
      {
        installation: decodeInstallationId("https://gerrit.hn.example.test/"),
        sshHost: { host: "gerrit-ssh.hn.example.test" },
        bindings: [],
      },
    ]);
    const endpoint = resolveRemoteEndpoint(
      "ssh://jorge.sarez@gerrit-ssh.hn.example.test:29418/CICD_Tools",
      configuration,
    );
    expect(endpoint).toEqual({
      kind: "candidate",
      repositories: [{ installation: "https://gerrit.hn.example.test/", project: "CICD_Tools" }],
    });
    const remotes = decodeDiscovery({
      remotes: [
        {
          name: "origin",
          configured: { fetch: [endpoint], push: [endpoint] },
          effective: { fetch: [endpoint], push: [endpoint] },
        },
      ],
      upstream: {
        kind: "branch",
        localBranch: "develop/master",
        remoteNames: ["origin"],
        mergeBranches: ["develop/master"],
      },
      binding: { kind: "not-bound", reason: "no-known-repository" },
    }).remotes;
    const repository = decodeRepository({
      installation: "https://gerrit.hn.example.test/",
      project: "CICD_Tools",
    });
    const target = decodeTarget("develop/master");
    expect(selectRemoteBinding({ remotes, repository, target })).toEqual({
      kind: "bound",
      scope: {
        installation: "https://gerrit.hn.example.test/",
        project: "CICD_Tools",
        branch: "develop/master",
      },
    });
  });

  it.each([
    "",
    "main..next",
    "main.lock",
    "main/.hidden",
    "main//next",
    "main@{1}",
    "-option",
    "main?",
    "main ",
    "main\\next",
  ])("rejects an invalid target branch %s", (target) => expect(isTarget(target)).toBe(false));
});
