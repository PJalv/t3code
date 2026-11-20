import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand as OrchestrationCommand,
  PullRequestOperationError,
  type OrchestrationProjectShell,
  type PullRequestActionInput,
  type PullRequestDiffResult,
  type PullRequestSubmitReviewInput,
  type PullRequestActivity,
  type PullRequestListInput,
  type PullRequestDetail,
  type PullRequestGerritDetail,
  type PullRequestRef,
  type PullRequestReviewGuideResult,
  type ThreadPullRequestLink,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as GitManager from "../../../git/GitManager.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import {
  type PullRequestTestThread,
  v2PullRequestThread,
} from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestWatchService from "../../../pullRequest/PullRequestWatchService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as GerritNativeAction from "../../../sourceControl/GerritNativeAction.ts";
import * as GerritWatchCompletion from "../../../sourceControl/GerritWatchCompletion.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { listThreadPullRequests } from "./handlers.ts";
import * as PullRequestsHandlers from "./handlers.ts";
import { CHILD_PULL_REQUEST_REPORT_NEXT, PullRequestsToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const testCrypto = SecureRandom.make((size) => new Uint8Array(size).fill(7));

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeProject(
  repositoryIdentity: OrchestrationProjectShell["repositoryIdentity"] = {
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:T3Tools/T3Code.git",
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: "T3Tools/T3Code",
    owner: "T3Tools",
    name: "T3Code",
  },
): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeThread(pullRequests: ReadonlyArray<ThreadPullRequestLink>): PullRequestTestThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  };
}

function makeLink(
  number: number,
  overrides: Partial<ThreadPullRequestLink> & {
    readonly headBranch?: string;
    readonly baseBranch?: string;
  } = {},
): ThreadPullRequestLink {
  const { headBranch, baseBranch, ...rest } = overrides;
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-08-10T00:00:00.000Z",
    snapshot:
      headBranch === undefined
        ? null
        : {
            state: "open",
            title: `PR ${number}`,
            headBranch,
            baseBranch: baseBranch ?? "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-08-27T00:00:00.000Z",
          },
    stack: null,
    ...rest,
  };
}

interface HarnessOptions {
  readonly thread?: PullRequestTestThread | null;
  readonly project?: OrchestrationProjectShell | null;
  readonly reject?: (command: OrchestrationCommand) => string | null;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly generate?: (
    input: PullRequestRef,
  ) => Effect.Effect<
    PullRequestReviewGuideResult & { started: boolean },
    PullRequestOperationError
  >;
  readonly pullRequests?: Partial<PullRequestService.PullRequestService["Service"]>;
  readonly git?: Partial<GitManager.GitManager["Service"]>;
}

const NO_GUIDE: PullRequestReviewGuideResult = { guide: null, run: null, currentHeadSha: "head-1" };

const makeHarness = Effect.fn("makePullRequestsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const guideRequests = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const thread = options.thread === undefined ? makeThread([]) : options.thread;
  const project = options.project === undefined ? makeProject() : options.project;
  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null)
        return yield* new Orchestrator.OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: rejection,
        });
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1, storedEvents: [] };
    });
  const layerDependencies = Layer.mergeAll(
    Layer.mock(PullRequestWatchService.PullRequestWatchService)({}),
    Layer.mock(ProjectService.ProjectService)({
      getShell: () => Effect.succeed(Option.fromNullishOr(project)),
      listShells: () => Effect.succeed(options.projects ?? (project ? [project] : [])),
    }),
    Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({
      get: () => Effect.succeed(NO_GUIDE),
      generate: (input) =>
        Ref.update(guideRequests, (recorded) => [...recorded, input]).pipe(
          Effect.andThen(
            options.generate?.(input) ??
              Effect.succeed({
                ...NO_GUIDE,
                run: {
                  _tag: "Running" as const,
                  headSha: "head-1",
                  startedAt: "2026-10-11T00:00:00.000Z",
                },
                started: true,
              }),
          ),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) =>
        Effect.succeed(id === thread?.id ? v2PullRequestThread(thread) : null),
      dispatch,
    }),
    Layer.mock(PullRequestService.PullRequestService)(options.pullRequests ?? {}),
    Layer.mock(GitManager.GitManager)(options.git ?? {}),
    Layer.succeed(SecureRandom.SecureRandom, testCrypto),
    McpToolAccessTestkit.liveThreadsLayer,
  );
  const toolkit = yield* PullRequestsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(PullRequestsHandlers.layer).pipe(
        Layer.provide(GerritWatchCompletion.layer),
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof PullRequestsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["pull-requests"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof PullRequestsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(layerDependencies),
    );
  return { commands, guideRequests, call };
});

describe("pull request toolkit handlers", () => {
  it.effect("refuses a credential without the pull-requests capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("list_thread_pull_requests", {}, ["preview"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "pull-requests",
        threadId: THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("points a bare thread uuid at the mcp: thread it belongs to", () =>
    Effect.gen(function* () {
      const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
      const harness = yield* makeHarness({
        thread: { ...makeThread([]), id: ThreadId.make(`mcp:${bareId}`) },
      });
      const error = yield* harness
        .call("link_pull_request", { threadId: bareId, number: 123 })
        .pipe(Effect.flip);
      expect(error.message).toBe(
        `Thread ${bareId} was not found. Did you mean \`mcp:${bareId}\`? Thread ids belong to one environment: for a thread on a linked one, find it with \`t3_environment_links\` and pass its \`environmentId\` to a tool that takes one.`,
      );
      expect(error).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "thread_not_found" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("links by URL with source agent on the token's thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/T3Tools/T3Code/pull/123/files",
      });
      expect(result).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 123,
        url: "https://github.com/T3Tools/T3Code/pull/123/files",
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.pull-request.link",
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 123,
          source: "agent",
        },
      ]);
    }),
  );

  it.effect("asks a subagent thread to end with its PR report after it links", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: {
          ...makeThread([]),
          lineage: {
            rootThreadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        },
      });
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/124",
      });
      expect(result).toMatchObject({ number: 124, next: CHILD_PULL_REQUEST_REPORT_NEXT });
    }),
  );

  it.effect("canonicalizes GitCafe links independently of the thread's project host", () =>
    Effect.gen(function* () {
      for (const host of ["git.cafe", "staging.git.cafe"]) {
        for (const project of [makeProject(), makeProject(null)]) {
          for (const target of [
            { host, repository: "PingDotGG/T3Code", number: 21353 },
            { url: `https://${host}/PingDotGG/T3Code/pull/21353` },
            { url: `https://${host}/PingDotGG/T3Code/pulls/21353` },
          ]) {
            const harness = yield* makeHarness({ project });
            const result = yield* harness.call("link_pull_request", target);
            const url = `https://${host}/pingdotgg/t3code/pulls/21353`;
            expect(result).toMatchObject({
              host,
              repository: "pingdotgg/t3code",
              number: 21353,
              url,
            });
            expect(yield* Ref.get(harness.commands)).toMatchObject([
              {
                type: "thread.pull-request.link",
                host,
                repository: "pingdotgg/t3code",
                number: 21353,
                url,
              },
            ]);
          }
        }
      }
    }),
  );

  it.effect("builds the URL in the project host's own shape", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "gitlab.com/group/sub/project",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@gitlab.com:group/sub/project.git",
          },
          provider: SourceControlProviderKind.make("gitlab"),
          displayName: "group/sub/project",
        }),
      });
      const result = yield* harness.call("link_pull_request", {
        repository: "group/sub/project",
        number: 42,
      });
      expect(result.url).toBe("https://gitlab.com/group/sub/project/-/merge_requests/42");
      expect(result.host).toBe("gitlab.com");
      const other = yield* harness.call("link_pull_request", {
        host: "gitlab.example.test",
        repository: "team/repo",
        number: 7,
      });
      expect(other.url).toBe("https://gitlab.example.test/team/repo/-/merge_requests/7");
      const onGitHub = yield* harness.call("link_pull_request", {
        host: "github.com",
        repository: "acme/web",
        number: 9,
      });
      expect(onGitHub.url).toBe("https://github.com/acme/web/pull/9");
    }),
  );

  it.effect("links a bare number in the checkout's repository, keeping its case", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* harness.call("link_pull_request", { number: 12 })).toMatchObject({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 12,
        url: "https://github.com/T3Tools/T3Code/pull/12",
      });
    }),
  );

  it.effect("links Gerrit changes by number and by every change URL form", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "review.example/group/repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://review.example/base/a/Group/Repo",
          },
          provider: SourceControlProviderKind.make("gerrit"),
          displayName: "Group/Repo",
        }),
      });
      const canonical = "https://review.example/base/c/Group/Repo/+/42";
      expect((yield* harness.call("link_pull_request", { number: 42 })).url).toBe(canonical);
      for (const url of [canonical, "https://review.example/base/c/42"]) {
        expect(yield* harness.call("link_pull_request", { url })).toMatchObject({
          host: "review.example",
          repository: "group/repo",
          number: 42,
        });
      }
    }),
  );

  it.effect("links a URL but not a bare number when the project's host is unknown", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "scm.example.test/tfs/collection/project/_git/repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "http://dummy:secret@scm.example.test:8080/tfs/Collection/Project/_git/Repo",
          },
          provider: SourceControlProviderKind.make("unknown"),
          displayName: "tfs/collection/project/_git/repo",
        }),
      });
      const error = yield* harness
        .call("link_pull_request", { repository: "tfs/Collection/Project/_git/Repo", number: 124 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestUrlUnavailableError" });

      const supplied = "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/123";
      const fromUrl = yield* harness.call("link_pull_request", { url: supplied });
      expect(fromUrl).toEqual({
        host: "scm.example.test",
        repository: "tfs/collection/project/_git/repo",
        number: 123,
        url: supplied,
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.link", number: 123, url: supplied },
      ]);
    }),
  );

  it.effect("treats a duplicate link as alreadyLinked rather than an error", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(123)]),
        reject: (command) =>
          command.type === "thread.pull-request.link" ? "already linked" : null,
      });
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/123",
      });
      expect(result.alreadyLinked).toBe(true);
    }),
  );

  it.effect("unlinks a linked pull request and reports a missing one as wasLinked=false", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(5)]),
        reject: (command) =>
          command.type === "thread.pull-request.unlink" && command.number !== 5
            ? "not linked"
            : null,
      });
      const linked = yield* harness.call("unlink_pull_request", {
        repository: "t3tools/t3code",
        number: 5,
      });
      expect(linked).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 5,
        wasLinked: true,
      });
      const missing = yield* harness.call("unlink_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/9",
      });
      expect(missing.wasLinked).toBe(false);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.unlink", number: 5 },
      ]);
    }),
  );

  it.effect("reports a dismissed stack member as not linked and leaves it dismissed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(9, { source: "stack-dismissed" })]),
      });
      const result = yield* harness.call("unlink_pull_request", {
        repository: "t3tools/t3code",
        number: 9,
      });
      expect(result.wasLinked).toBe(false);
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("links several pull requests in one call", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(1), { ...makeLink(2), source: "stack-dismissed" }]),
      });
      const url = (number: number) => `https://github.com/t3tools/t3code/pull/${number}`;
      const result = yield* harness.call("link_pull_requests", {
        urls: [url(1), url(2), url(3), url(3), "https://example.com/not-a-pr"],
      });
      expect(result).toEqual({
        linked: [{ host: "github.com", repository: "t3tools/t3code", numbers: [2, 3] }],
        alreadyLinked: [{ host: "github.com", repository: "t3tools/t3code", numbers: [1] }],
        linkedCount: 3,
        invalidUrls: ["https://example.com/not-a-pr"],
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.link", number: 2, source: "agent" },
        { type: "thread.pull-request.link", number: 3, source: "agent" },
      ]);
    }),
  );

  it.effect("unlinks every visible pull request in the given states in one call", () =>
    Effect.gen(function* () {
      const withState = (number: number, state: "open" | "closed" | "merged") => {
        const link = makeLink(number, { headBranch: `branch-${number}` });
        return { ...link, snapshot: { ...link.snapshot!, state } };
      };
      const harness = yield* makeHarness({
        thread: makeThread([
          withState(1, "merged"),
          withState(2, "open"),
          withState(3, "closed"),
          makeLink(4),
          { ...withState(5, "merged"), source: "stack-dismissed" },
        ]),
      });
      const result = yield* harness.call("unlink_pull_requests", {
        states: ["closed", "merged"],
      });
      expect(result).toEqual({
        unlinked: [
          { host: "github.com", repository: "t3tools/t3code", state: "merged", numbers: [1] },
          { host: "github.com", repository: "t3tools/t3code", state: "closed", numbers: [3] },
        ],
        unlinkedCount: 2,
        remaining: 2,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.unlink", number: 1 },
        { type: "thread.pull-request.unlink", number: 3 },
      ]);
    }),
  );

  it("reports an older Forgejo link's HTTP port when listing thread links", () => {
    const result = listThreadPullRequests(
      makeThread([
        makeLink(42, {
          host: "forge.example",
          url: "http://forge.example:3000/t3tools/t3code/pulls/42",
        }),
      ]),
    );
    expect(result.pullRequests[0]?.host).toBe("forge.example:3000");
  });

  it.effect("lists visible links with host state and derived chain order", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([
          makeLink(3, { headBranch: "feat-c", baseBranch: "feat-b", source: "agent" }),
          makeLink(1, { headBranch: "feat-a", baseBranch: "main", source: "created" }),
          makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a", source: "agent" }),
          makeLink(9, { source: "stack-dismissed" }),
          makeLink(10),
        ]),
      });
      const result = yield* harness.call("list_thread_pull_requests", {});
      expect(result.pullRequests.map((entry) => entry.number)).toEqual([1, 2, 3, 10]);
      expect(result.pullRequests[2]).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 3,
        url: "https://github.com/t3tools/t3code/pull/3",
        source: "agent",
        watching: false,
        state: "open",
        title: "PR 3",
        headBranch: "feat-c",
        baseBranch: "feat-b",
        isDraft: false,
        stack: { kind: "derived", position: 3, size: 3 },
      });
      expect(result.pullRequests[3]).toMatchObject({
        number: 10,
        state: null,
        title: null,
        headBranch: null,
        stack: null,
      });
      expect(result.chains).toEqual([
        { kind: "derived", numbers: [1, 2, 3] },
        { kind: "derived", numbers: [10] },
      ]);
    }),
  );
});

describe("listThreadPullRequests", () => {
  it("reports a native stack position for each member", () => {
    const stack = {
      kind: "native" as const,
      id: "stack-1",
      number: 1,
      url: "https://github.com/t3tools/t3code/stack/1",
      base: "main",
      layers: [
        { number: 1, headBranch: "a", state: "open" as const },
        { number: 2, headBranch: "b", state: "open" as const },
      ],
    };
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(2, { stack, source: "stack" }),
        makeLink(1, { stack, source: "created" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [1, { kind: "native", position: 1, size: 2 }],
      [2, { kind: "native", position: 2, size: 2 }],
    ]);
    expect(result.chains).toEqual([{ kind: "native", numbers: [1, 2] }]);
  });

  it("gives pull requests built on the same one the same position", () => {
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(1, { headBranch: "feat-a", baseBranch: "main" }),
        makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a" }),
        makeLink(3, { headBranch: "feat-c", baseBranch: "feat-a" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [1, { kind: "derived", position: 1, size: 3 }],
      [2, { kind: "derived", position: 2, size: 3 }],
      [3, { kind: "derived", position: 2, size: 3 }],
    ]);
    expect(result.chains).toEqual([{ kind: "derived", numbers: [1, 2, 3] }]);
  });

  it("pages a large list once through, with each page's stacks whole", () => {
    const thread = {
      pullRequests: [
        makeLink(1, { headBranch: "feat-a" }),
        ...Array.from({ length: 118 }, (_, index) => makeLink(index + 2)),
        makeLink(120, { headBranch: "feat-z", baseBranch: "feat-a" }),
      ],
    };
    const pages = [listThreadPullRequests(thread)];
    for (let next = pages[0]!.nextCursor; next !== null; next = pages.at(-1)!.nextCursor) {
      pages.push(listThreadPullRequests(thread, next));
    }
    expect(pages.map((page) => page.pullRequests.length)).toEqual([50, 50, 20]);
    expect(pages.flatMap((page) => page.pullRequests.map((entry) => entry.number))).toEqual(
      Array.from({ length: 120 }, (_, index) => index + 1),
    );
    const stack = { kind: "derived", numbers: [1, 120] };
    expect(pages.map((page) => page.chains.length)).toEqual([50, 50, 20]);
    expect(pages.map((page) => page.chains.filter((chain) => chain.numbers.length > 1))).toEqual([
      [stack],
      [],
      [stack],
    ]);

    // Unlinking the first page must not shift the cursor past PRs not yet seen.
    const remaining = { pullRequests: thread.pullRequests.slice(50) };
    expect(
      listThreadPullRequests(remaining, pages[0]!.nextCursor!).pullRequests.map(
        (entry) => entry.number,
      ),
    ).toEqual(Array.from({ length: 50 }, (_, index) => index + 51));
  });

  it("filters by state before paging, counting a PR with no known state as open", () => {
    const merged = (number: number) => {
      const link = makeLink(number, { headBranch: `feat-${number}` });
      return { ...link, snapshot: { ...link.snapshot!, state: "merged" as const } };
    };
    const thread = {
      pullRequests: [
        ...Array.from({ length: 50 }, (_, index) => merged(index + 1)),
        ...Array.from({ length: 10 }, (_, index) => makeLink(index + 51)),
      ],
    };
    const open = listThreadPullRequests(thread, undefined, ["open"]);
    expect(open.pullRequests.map((entry) => entry.number)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 51),
    );
    expect(open.nextCursor).toBeNull();
    expect(listThreadPullRequests(thread, undefined, ["merged"]).nextCursor).toBeNull();
  });
});

describe("pull request guide tools", () => {
  it.effect(
    "writes guides through the project whose checkout is each pull request's repository",
    () =>
      Effect.gen(function* () {
        const other = {
          ...makeProject({
            canonicalKey: "github.com/acme/web",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "git@github.com:acme/web.git",
            },
            provider: SourceControlProviderKind.make("github"),
            displayName: "acme/web",
            owner: "acme",
            name: "web",
          }),
          id: ProjectId.make("project-web"),
        };
        const harness = yield* makeHarness({ projects: [makeProject(), other] });
        const result = yield* harness.call("write_pull_request_guides", {
          pullRequests: [
            { url: "https://github.com/acme/web/pull/7" },
            { repository: "t3tools/t3code", number: 12 },
            { url: "https://github.com/someone/else/pull/1" },
          ],
        });
        expect(
          result.guides.map((guide) => [guide.repository, guide.number, guide.outcome]),
        ).toEqual([
          ["acme/web", 7, "started"],
          ["t3tools/t3code", 12, "started"],
          ["someone/else", 1, "failed"],
        ]);
        expect(result.guides[2]?.detail).toContain("No project in this environment");
        expect(
          (yield* Ref.get(harness.guideRequests)).map((ref) => [ref.projectId, ref.number]),
        ).toEqual([
          ["project-web", 7],
          [PROJECT_ID, 12],
        ]);
      }),
  );

  it.effect("reports an unreadable entry on its own and still writes the rest of the batch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [
          { url: "https://example.com/not-a-pull-request" },
          { repository: "t3tools/t3code" },
          { repository: "t3tools/t3code", number: 5 },
        ],
      });
      expect(result.guides.map((guide) => guide.outcome)).toEqual(["failed", "failed", "started"]);
      expect(result.guides[0]?.detail).toContain("not a recognised pull request URL");
      expect(result.guides[1]?.detail).toContain("Pass either url");
      expect((yield* Ref.get(harness.guideRequests)).map((ref) => ref.number)).toEqual([5]);
    }),
  );

  it.effect(
    "reads a guide on a host readable without a checkout through the caller's project",
    () =>
      Effect.gen(function* () {
        const api = makeProject({
          canonicalKey: "bitbucket.org/acme/api",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@bitbucket.org:acme/api.git",
          },
          provider: SourceControlProviderKind.make("bitbucket"),
          displayName: "acme/api",
          owner: "acme",
          name: "api",
        });
        const harness = yield* makeHarness({ project: api });
        const result = yield* harness.call("read_pull_request_guide", {
          url: "https://bitbucket.org/acme/web/pull-requests/123",
        });
        expect(result).toMatchObject({
          host: "bitbucket.org",
          repository: "acme/web",
          number: 123,
          guide: null,
          currentHeadSha: "head-1",
        });
      }),
  );

  it.effect("finds an Azure DevOps checkout for a pull request named by its full path", () =>
    Effect.gen(function* () {
      const azure = {
        ...makeProject({
          canonicalKey: "dev.azure.com/org/project/_git/web",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://dev.azure.com/org/project/_git/web",
          },
          provider: SourceControlProviderKind.make("azure-devops"),
          displayName: "org/project/_git/web",
          owner: "org",
          name: "web",
        }),
        id: ProjectId.make("project-azure"),
      };
      const harness = yield* makeHarness({ projects: [makeProject(), azure] });
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [{ host: "dev.azure.com", repository: "org/project/_git/web", number: 9 }],
      });
      expect(result.guides.map((guide) => guide.outcome)).toEqual(["started"]);
      expect((yield* Ref.get(harness.guideRequests)).map((ref) => ref.projectId)).toEqual([
        "project-azure",
      ]);
    }),
  );
});

describe("source control tools", () => {
  const branchThread = {
    ...makeThread([]),
    worktreePath: "/workspace/worktree",
    branchPullRequest: {
      projectId: PROJECT_ID,
      repository: "t3tools/t3code",
      number: 42,
      url: "https://github.com/t3tools/t3code/pull/42",
    },
  };
  const gerritProject = makeProject({
    canonicalKey: "review.example/acme/app",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "ssh://review.example:29418/acme/app",
    },
    provider: SourceControlProviderKind.make("gerrit"),
    displayName: "acme/app",
    owner: "acme",
    name: "app",
  });
  const gerrit: PullRequestGerritDetail = {
    changeId: "I123",
    topic: null,
    isPrivate: false,
    isWip: false,
    currentPatchSet: 3,
    patchSets: [{ number: 3, commit: "abc123", createdAt: "2026-11-01T00:00:00Z" }],
    labels: [{ name: "Code-Review", votes: [], permittedValues: [-1, 0, 1] }],
    submitRequirements: [{ name: "Review", status: "unsatisfied" }],
    submittable: false,
  };
  const detail = {
    title: "Add tools",
    body: "Adds tools.",
    state: "open",
    isDraft: false,
    author: null,
    headBranch: "tools",
    baseBranch: "main",
    headSha: "abc123",
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    labels: [],
    reviewers: [],
    checks: [{ name: "CI", status: "success", description: null, url: null }],
  } as unknown as PullRequestDetail;
  const reviewThread = (id: string, isResolved: boolean) => ({
    id,
    path: "a.ts",
    line: 1,
    side: "right" as const,
    isResolved,
    isOutdated: false,
    comments: [],
  });
  const activity: PullRequestActivity = {
    comments: [],
    commentCount: 0,
    commentsTruncated: false,
    reviewThreads: [reviewThread("open-thread", false), reviewThread("done-thread", true)],
    commits: [],
  };

  it.effect("reads the thread's branch PR, only the sections asked, without resolved threads", () =>
    Effect.gen(function* () {
      const asked: Array<PullRequestRef> = [];
      const harness = yield* makeHarness({
        thread: branchThread,
        pullRequests: {
          detail: (ref) => Effect.sync(() => asked.push(ref)).pipe(Effect.as(detail)),
          activity: () => Effect.succeed(activity),
        },
      });
      const result = yield* harness.call("pull_request_read", {
        sections: ["summary", "conversation"],
      });
      expect(asked).toEqual([
        {
          projectId: PROJECT_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
          allowStale: false,
        },
      ]);
      expect(result.summary?.headSha).toBe("abc123");
      expect(result.checks).toBeUndefined();
      expect(result.conversation?.reviewThreads.map((thread) => thread.id)).toEqual([
        "open-thread",
      ]);
      expect(result.conversation?.hiddenResolvedThreads).toBe(1);
    }),
  );

  it.effect("keeps Gerrit anchors and native requirements but never returns private drafts", () =>
    Effect.gen(function* () {
      const anchor = {
        patchSet: 1,
        revision: "old-head",
        parent: 2,
        range: { start_line: 1, start_character: 0, end_line: 2, end_character: 4 },
      };
      const published = {
        id: "published-comment",
        author: null,
        body: "Old parent-side feedback",
        createdAt: "2026-11-01T00:00:00Z",
        url: null,
        gerrit: anchor,
        isDraft: false,
      };
      const draft = { ...published, id: "draft", body: "PRIVATE", isDraft: true };
      const harness = yield* makeHarness({
        thread: branchThread,
        pullRequests: {
          detail: () => Effect.succeed({ ...detail, gerrit }),
          activity: () =>
            Effect.succeed({
              ...activity,
              comments: [{ ...draft, kind: "review-comment", path: "a.ts", reviewState: null }],
              commentsTruncated: true,
              reviewThreads: [
                { ...reviewThread("private", false), isDraft: true, comments: [draft] },
                {
                  ...reviewThread("mixed", false),
                  side: "left",
                  gerrit: anchor,
                  canResolve: false,
                  comments: [published, draft],
                  nextCommentsCursor: "rest",
                },
              ],
            }),
          threadComments: () =>
            Effect.succeed({ comments: [draft, { ...published, id: "reply" }], nextCursor: null }),
        },
      });
      const result = yield* harness.call("pull_request_read", {
        sections: ["summary", "conversation"],
      });
      expect(result.summary?.gerrit).toEqual(gerrit);
      expect(result.summary?.next).toContain("read_gerrit");
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      expect(result.conversation).toMatchObject({
        comments: [],
        truncated: true,
        nextCursor: null,
        reviewThreads: [
          {
            id: "mixed",
            side: "left",
            gerrit: anchor,
            canResolve: false,
            comments: [
              { id: "published-comment", gerrit: anchor, isDraft: false },
              { id: "reply", gerrit: anchor },
            ],
            moreComments: false,
          },
        ],
      });
      expect(result.conversation?.reviewThreads).toHaveLength(1);
      const bounded = yield* makeHarness({
        thread: branchThread,
        pullRequests: {
          detail: () =>
            Effect.succeed({
              ...detail,
              gerrit: {
                ...gerrit,
                patchSets: Array.from({ length: 70 }, (_, index) => ({
                  ...gerrit.patchSets[0]!,
                  number: index + 1,
                })),
                currentPatchSet: 70,
              },
            }),
        },
      });
      const summary = (yield* bounded.call("pull_request_read", { sections: ["summary"] })).summary;
      expect(summary?.gerritTruncated).toBe(true);
      expect(summary?.gerrit?.patchSets).toHaveLength(50);
      expect(summary?.gerrit?.patchSets.at(-1)?.number).toBe(70);
    }),
  );

  it.effect(
    "routes unsupported Gerrit operations before any write, while retaining supported updates",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        let actions: PullRequestDetail["viewerPermissions"]["actions"] = [
          "ready",
          "draft",
          "close",
          "reopen",
        ];
        const harness = yield* makeHarness({
          project: gerritProject,
          thread: branchThread,
          git: { createPullRequest: () => Effect.die("must use upload_gerrit") },
          pullRequests: {
            detail: () =>
              Effect.sync(() => ({
                ...detail,
                gerrit,
                capabilities: {
                  ...detail.capabilities,
                  actions: ["ready", "draft", "close", "reopen"],
                  reviewers: { request: true, listCandidates: true },
                },
                viewerPermissions: { ...detail.viewerPermissions, actions, requestReviewers: true },
              })),
            update: () => Effect.sync(() => void calls.push("update")),
            setLabels: () => Effect.sync(() => void calls.push("labels")),
            submitReview: () => Effect.sync(() => void calls.push("review")),
            runAction: (input) => Effect.sync(() => void calls.push(input.action)),
            reviewerCandidates: () =>
              Effect.succeed({
                candidates: [{ id: "101", kind: "user", login: "reviewer" }],
              } as never),
            requestReviewers: () => Effect.sync(() => void calls.push("reviewers")),
          },
        });
        expect(
          (yield* harness.call("pull_request_create", { title: "x", body: "x" }).pipe(Effect.flip))
            .message,
        ).toContain("upload_gerrit");
        for (const unsupported of [
          { title: "x" },
          { body: "x" },
          { addLabels: ["Code-Review"] },
          { removeLabels: ["Verified"] },
        ]) {
          const error = yield* harness
            .call("pull_request_update", {
              ...unsupported,
              ready: true,
              requestReviewers: ["reviewer"],
            })
            .pipe(Effect.flip);
          expect(error.message).toContain("act_gerrit");
        }
        expect(
          (yield* harness
            .call("pull_request_respond", {
              reviewThreadId: "gerrit:comment",
              body: "reply",
              resolved: true,
            })
            .pipe(Effect.flip)).message,
        ).toContain("act_gerrit");
        expect(
          (yield* harness.call("pull_request_review", { verdict: "approve" }).pipe(Effect.flip))
            .message,
        ).toContain("act_gerrit");
        expect(
          (yield* harness
            .call("pull_request_merge", { expectedHeadSha: "abc123", auto: true })
            .pipe(Effect.flip)).message,
        ).toContain("act_gerrit");
        expect(calls).toEqual([]);
        actions = ["ready"];
        const denied = yield* harness
          .call("pull_request_update", { ready: true, state: "closed" })
          .pipe(Effect.flip);
        expect(denied.message).toContain("close");
        expect(calls).toEqual([]);
        actions = ["ready", "draft", "close", "reopen"];
        yield* harness.call("pull_request_update", {
          ready: true,
          state: "closed",
          requestReviewers: ["reviewer"],
        });
        yield* harness.call("pull_request_update", { ready: false, state: "open" });
        expect(calls).toEqual(["reviewers", "ready", "close", "draft", "reopen"]);
      }),
  );

  it.effect.each([
    { name: "own abandon", fails: false },
    { name: "failed abandon", fails: true },
  ])("records a generic Gerrit close as the caller's own ($name)", ({ fails }) =>
    Effect.gen(function* () {
      const startedAt = "2026-08-20T00:00:00.000Z";
      const actions: Array<unknown> = [];
      const harness = yield* makeHarness({
        project: gerritProject,
        thread: {
          ...branchThread,
          pullRequests: [
            makeLink(42, {
              host: "review.example",
              repository: "acme/app",
              url: "https://review.example/c/acme/app/+/42",
              watch: {
                startedAt,
                headSha: "abc123",
                failedChecks: [],
                passed: false,
                passedChecks: [],
                remarksThrough: startedAt,
                remarkIds: [],
                conflicting: false,
                wakes: 0,
              },
            }),
          ],
        },
        pullRequests: {
          detail: () =>
            Effect.succeed({
              ...detail,
              gerrit,
              capabilities: { ...detail.capabilities, actions: ["close"] },
              viewerPermissions: { ...detail.viewerPermissions, actions: ["close"] },
            }),
          // The service names the change it abandons by its resolved Gerrit installation.
          runAction: (input) =>
            Effect.gen(function* () {
              const action = {
                server: "https://review.example/",
                project: input.repository,
                number: input.number,
                operation: "abandon" as const,
              };
              actions.push(action);
              return yield* (yield* GerritNativeAction.NativeAction)(
                action,
                fails
                  ? Effect.fail(
                      new PullRequestOperationError({ operation: "runAction", detail: "denied" }),
                    )
                  : Effect.undefined,
              );
            }),
        },
      });
      const result = yield* harness
        .call("pull_request_update", { number: 42, state: "closed" })
        .pipe(Effect.result);
      expect(result._tag).toBe(fails ? "Failure" : "Success");
      expect(actions).toEqual([
        {
          server: "https://review.example/",
          project: "acme/app",
          number: 42,
          operation: "abandon",
        },
      ]);
      // A cleared watch sends no closed wake; a failed abandon leaves the watch to report the host.
      expect(
        (yield* Ref.get(harness.commands)).filter(
          (command) => command.type === "thread.pull-request-watch.sync",
        ),
      ).toEqual(
        fails
          ? []
          : [
              expect.objectContaining({
                threadId: THREAD_ID,
                host: "review.example",
                repository: "acme/app",
                number: 42,
                startedAt,
                watch: null,
              }),
            ],
      );
    }),
  );

  it.effect("pages a long conversation and the PR list through the cursors they return", () =>
    Effect.gen(function* () {
      const comment = (body: string) =>
        ({ id: body.slice(0, 8), author: null, body, createdAt: "2026-11-01T00:00:00Z" }) as never;
      const long = (id: string) => ({
        ...reviewThread(id, false),
        comments: [comment("x".repeat(20_000))],
      });
      const listed: Array<PullRequestListInput> = [];
      let firstResolved = false;
      const harness = yield* makeHarness({
        thread: branchThread,
        pullRequests: {
          activity: () =>
            Effect.sync(() => ({
              ...activity,
              reviewThreads: [
                { ...long("private"), isDraft: true },
                {
                  ...long("first"),
                  isResolved: firstResolved,
                  nextCommentsCursor: "later",
                },
                long("second"),
                reviewThread("done-thread", true),
              ],
            })),
          threadComments: (input) =>
            Effect.succeed(
              input.cursor === "later"
                ? { comments: [comment("reply")], nextCursor: null }
                : { comments: [], nextCursor: null },
            ),
          list: (input) =>
            Effect.sync(() => listed.push(input)).pipe(
              Effect.as({
                viewers: {},
                providers: [],
                entries: [],
                errors: [],
                truncated: input.cursors === undefined,
                nextCursors: input.cursors === undefined ? { "t3tools/t3code": "page-2" } : {},
              }),
            ),
        },
      });
      const first = yield* harness.call("pull_request_read", { sections: ["conversation"] });
      expect(first.conversation?.reviewThreads).toMatchObject([
        { id: "first", moreComments: false, comments: [{}, { body: "reply" }] },
      ]);
      const cursor = first.conversation?.nextCursor;
      expect(cursor).toEqual(expect.any(String));
      // The agent resolves what it read; the next page still starts at the next thread.
      firstResolved = true;
      const second = yield* harness.call("pull_request_read", { cursor: cursor! });
      expect(second.summary).toBeUndefined();
      expect(second.conversation?.reviewThreads.map((thread) => thread.id)).toEqual(["second"]);
      expect(second.conversation?.nextCursor).toBeNull();
      // A cursor past the current end finishes instead of repeating an empty page.
      const stale = Base64Url.encode(
        JSON.stringify({ threads: 99, comments: 99, includeResolved: false }),
      );
      const past = yield* harness.call("pull_request_read", { cursor: stale });
      expect(past.conversation).toMatchObject({ reviewThreads: [], nextCursor: null });

      const page = yield* harness.call("pull_request_list", {});
      yield* harness.call("pull_request_list", { cursor: page.nextCursor! });
      expect(listed.map((input) => input.cursors)).toEqual([
        undefined,
        { "t3tools/t3code": "page-2" },
      ]);
      const invalid = yield* harness
        .call("pull_request_read", { cursor: "not-a-cursor" })
        .pipe(Effect.flip);
      expect(invalid._tag).toBe("PullRequestCursorInvalidError");
    }),
  );

  it.effect("asks for a number when the thread's branch has no PR", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call("pull_request_read", {}).pipe(Effect.flip);
      expect(error._tag).toBe("PullRequestBranchHasNoneError");
    }),
  );

  it.effect("reads the PR this thread opened before status sync reports it", () =>
    Effect.gen(function* () {
      const asked: Array<PullRequestRef> = [];
      const opened = (headBranch: string) =>
        makeHarness({
          thread: { ...makeThread([makeLink(43, { source: "created" })]), branch: "tools" },
          pullRequests: {
            summary: () => Effect.succeed({ state: "open", headBranch } as never),
            detail: (ref) => Effect.sync(() => asked.push(ref)).pipe(Effect.as(detail)),
          },
        });
      const harness = yield* opened("tools");
      yield* harness.call("pull_request_read", { sections: ["summary"] });
      expect(asked).toMatchObject([{ number: 43 }]);

      // Before sync, the host says which branch it came from; another branch's is not this one.
      const moved = yield* opened("old");
      const unsynced = yield* moved.call("pull_request_read", {}).pipe(Effect.flip);
      expect(unsynced._tag).toBe("PullRequestBranchHasNoneError");

      // After a switch to another branch, the PR opened from the old one is not the branch's.
      const switched = yield* makeHarness({
        thread: {
          ...makeThread([makeLink(43, { source: "created", headBranch: "old" })]),
          branch: "new",
        },
      });
      const error = yield* switched
        .call("pull_request_update", { title: "New title" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("PullRequestBranchHasNoneError");
    }),
  );

  it.effect("merges pinned to the head the agent checked", () =>
    Effect.gen(function* () {
      const actions: Array<PullRequestActionInput> = [];
      const harness = yield* makeHarness({
        thread: branchThread,
        pullRequests: {
          runAction: (input) => Effect.sync(() => void actions.push(input)),
          summary: () => Effect.succeed({ state: "open" } as never),
        },
      });
      const result = yield* harness.call("pull_request_merge", {
        expectedHeadSha: "abc123",
        method: "squash",
        auto: true,
      });
      expect(result).toMatchObject({ number: 42, state: "open" });
      expect(actions).toMatchObject([
        {
          number: 42,
          action: "enable-auto-merge",
          expectedHeadSha: "abc123",
          mergeMethod: "squash",
        },
      ]);
    }),
  );

  it.effect("a stack merge pins every open layer up to the PR", () =>
    Effect.gen(function* () {
      const actions: Array<PullRequestActionInput> = [];
      let lowerHead: string | undefined = "bbb";
      const layer = (number: number, state: "open" | "merged", headSha: string | undefined) => ({
        number,
        state,
        ...(headSha === undefined ? {} : { headSha }),
        headBranch: `layer-${number}`,
      });
      const harness = yield* makeHarness({
        thread: branchThread,
        pullRequests: {
          stack: (_input, options) =>
            options?.bypassCache !== true
              ? Effect.die("a merge must not pin heads from the cache")
              : Effect.succeed({
                  id: "stack-1",
                  number: 7,
                  url: "https://github.com/acme/app/stacks/7",
                  base: "main",
                  layers: [
                    layer(40, "merged", "aaa"),
                    layer(41, "open", lowerHead),
                    layer(42, "open", "stale"),
                    layer(43, "open", "ddd"),
                  ],
                }),
          runAction: (input) => Effect.sync(() => void actions.push(input)),
          summary: () => Effect.succeed({ state: "merged" } as never),
        },
      });
      yield* harness.call("pull_request_merge", { expectedHeadSha: "ccc", stack: true });
      expect(actions).toMatchObject([
        {
          number: 42,
          action: "merge",
          stackNumber: 7,
          expectedStackHeads: [
            { number: 41, headSha: "bbb" },
            { number: 42, headSha: "ccc" },
          ],
        },
      ]);
      lowerHead = undefined;
      const unpinned = yield* harness
        .call("pull_request_merge", { expectedHeadSha: "ccc", stack: true })
        .pipe(Effect.flip);
      expect(unpinned._tag).toBe("PullRequestForgeError");
      expect(actions).toHaveLength(1);
    }),
  );

  it.effect("re-running checks reopens a watch that saw its checks finish", () =>
    Effect.gen(function* () {
      const watch = {
        startedAt: "2026-08-20T00:00:00.000Z",
        headSha: "abc123",
        failedChecks: ["test"],
        passed: false,
        passedChecks: [],
        remarksThrough: "2026-08-20T00:00:00.000Z",
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      };
      const rerun = (checksPending: boolean | undefined, reran: boolean) =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({
            thread: {
              ...branchThread,
              pullRequests: [
                makeLink(42, {
                  watch: checksPending === undefined ? watch : { ...watch, checksPending },
                }),
              ],
            },
            pullRequests: {
              rerunChecks: () => Effect.succeed([{ name: "test", rerun: reran, detail: null }]),
            },
          });
          yield* harness.call("ci_rerun", {});
          return yield* Ref.get(harness.commands);
        });
      expect(yield* rerun(false, true)).toMatchObject([
        { type: "thread.pull-request-watch.checks-reopen", threadId: THREAD_ID },
      ]);
      // Nothing re-ran, or the watch has no answer to clear.
      expect(yield* rerun(false, false)).toEqual([]);
      expect(yield* rerun(undefined, true)).toEqual([]);
    }),
  );

  it.effect("opens a PR from the thread's worktree and links it even if dismissed", () =>
    Effect.gen(function* () {
      const opened: Array<{ readonly cwd: string; readonly draft: boolean | undefined }> = [];
      const harness = yield* makeHarness({
        thread: {
          ...makeThread([makeLink(43, { source: "stack-dismissed" })]),
          worktreePath: "/workspace/worktree",
        },
        git: {
          createPullRequest: (input) =>
            Effect.sync(() => opened.push({ cwd: input.cwd, draft: input.draft })).pipe(
              Effect.as({
                status: "created" as const,
                url: "https://github.com/t3tools/t3code/pull/43",
                number: 43,
                baseBranch: "main",
                headBranch: "tools",
                title: input.title,
              }),
            ),
        },
      });
      const result = yield* harness.call("pull_request_create", {
        title: "Add tools",
        body: "Adds tools.",
        draft: true,
      });
      expect(result).toMatchObject({ number: 43, created: true });
      expect(opened).toEqual([{ cwd: "/workspace/worktree", draft: true }]);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.link", number: 43, source: "created" },
      ]);
    }),
  );

  it.effect("replies to and resolves a review thread, and refuses resolving without one", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const harness = yield* makeHarness({
        thread: branchThread,
        pullRequests: {
          replyToThread: (input) => Effect.sync(() => calls.push(`reply ${input.threadId}`)),
          setThreadResolution: (input) =>
            input.threadId === "locked-thread"
              ? Effect.fail(
                  new PullRequestOperationError({
                    operation: "setThreadResolution",
                    detail: "Locked.",
                  }),
                )
              : Effect.sync(() => void calls.push(`resolve ${input.threadId} ${input.resolved}`)),
        },
      });
      const result = yield* harness.call("pull_request_respond", {
        reviewThreadId: "open-thread",
        body: "Fixed.",
        resolved: true,
      });
      expect(result).toMatchObject({ replied: true, resolved: true });
      expect(calls).toEqual(["reply open-thread", "resolve open-thread true"]);
      const partial = yield* harness
        .call("pull_request_respond", {
          reviewThreadId: "locked-thread",
          body: "Fixed.",
          resolved: true,
        })
        .pipe(Effect.flip);
      expect(partial.message).toContain("The reply was posted");
      const error = yield* harness
        .call("pull_request_respond", { body: "Done", resolved: true })
        .pipe(Effect.flip);
      expect(error._tag).toBe("PullRequestNothingToDoError");
    }),
  );

  it.effect("places review comments by the diff page that shows their line", () =>
    Effect.gen(function* () {
      const reviews: Array<PullRequestSubmitReviewInput> = [];
      let rangeComment = true;
      const pages: Record<string, PullRequestDiffResult> = {
        first: {
          patch:
            "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n",
          truncated: false,
          nextCursor: "second",
        },
        second: {
          patch:
            "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -9,1 +9,2 @@\n kept\n+added\n",
          truncated: false,
          nextCursor: null,
        },
      };
      const harness = yield* makeHarness({
        thread: branchThread,
        pullRequests: {
          diff: (input) => Effect.succeed(pages[input.cursor ?? "first"]!),
          submitReview: (input) => Effect.sync(() => void reviews.push(input)),
          detail: () =>
            Effect.succeed({
              ...detail,
              capabilities: {
                ...detail.capabilities,
                review: {
                  inlineComment: true,
                  rangeComment,
                  reply: true,
                  resolve: true,
                  verdicts: ["comment", "approve", "request-changes"],
                },
              },
            }),
        },
      });
      yield* harness.call("pull_request_review", {
        verdict: "request-changes",
        body: "Two things.",
        comments: [
          { path: "b.ts", line: 10, startLine: 9, body: "Why?" },
          { path: "a.ts", line: 1, side: "old", body: "Keep this." },
        ],
      });
      expect(reviews).toMatchObject([
        {
          number: 42,
          verdict: "request-changes",
          body: "Two things.",
          comments: [
            {
              path: "b.ts",
              position: { kind: "added", newLine: 10 },
              startPosition: { kind: "context", oldLine: 9, newLine: 9, side: "right" },
            },
            { path: "a.ts", position: { kind: "deleted", oldLine: 1 } },
          ],
        },
      ]);

      // A line the diff never shows fails before anything is posted.
      const error = yield* harness
        .call("pull_request_review", {
          verdict: "comment",
          comments: [{ path: "a.ts", line: 40, body: "Here?" }],
        })
        .pipe(Effect.flip);
      expect(error.message).toContain("a.ts line 40 (new side) is not in this PR's diff");
      const backwards = yield* harness
        .call("pull_request_review", {
          verdict: "comment",
          comments: [{ path: "b.ts", line: 9, startLine: 10, body: "Range" }],
        })
        .pipe(Effect.flip);
      expect(backwards.message).toContain("startLine must not be after line");
      rangeComment = false;
      const unsupported = yield* harness
        .call("pull_request_review", {
          verdict: "comment",
          comments: [{ path: "b.ts", line: 10, startLine: 9, body: "Range" }],
        })
        .pipe(Effect.flip);
      expect(unsupported.message).toContain("does not support multiline");
      expect(reviews).toHaveLength(1);
    }),
  );

  it.effect("updates labels, requests reviewers by login, and closes the PR", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const harness = yield* makeHarness({
        thread: branchThread,
        pullRequests: {
          setLabels: (input) =>
            Effect.sync(() => void calls.push(["labels", input.labels, input.applied])),
          reviewerCandidates: (input) =>
            Effect.succeed({
              candidates: [
                {
                  id: "MDQ6VXNlcjE=",
                  kind: "user",
                  login: input.query === "Octo" ? "octo" : "x",
                  name: null,
                  avatarUrl: null,
                  isRequested: false,
                },
                {
                  id: "core",
                  kind: "team",
                  login: "acme/core",
                  name: null,
                  avatarUrl: null,
                  isRequested: false,
                },
              ],
            } as never),
          requestReviewers: (input) =>
            Effect.sync(() => void calls.push(["reviewers", input.reviewers])),
          runAction: (input) => Effect.sync(() => void calls.push(["action", input.action])),
        },
      });
      yield* harness.call("pull_request_update", {
        addLabels: ["bug"],
        removeLabels: ["wip"],
        requestReviewers: ["Octo", "acme/core"],
        state: "closed",
      });
      expect(calls).toEqual([
        ["labels", ["bug"], true],
        ["labels", ["wip"], false],
        [
          "reviewers",
          [
            { id: "MDQ6VXNlcjE=", kind: "user" },
            { id: "core", kind: "team" },
          ],
        ],
        ["action", "close"],
      ]);
      const unknown = yield* harness
        .call("pull_request_update", { requestReviewers: ["nobody"] })
        .pipe(Effect.flip);
      expect(unknown.message).toContain("No reviewer named nobody");
    }),
  );
});
