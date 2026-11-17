import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  GerritDirectReadRequest,
  GerritDirectUploadInput,
  gerritDirectDecodeOptions,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as GerritDirectRead from "../../../sourceControl/GerritDirectRead.ts";
import * as GerritDirectService from "../../../sourceControl/GerritDirectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Testkit from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { actInput, GerritDirectToolkit } from "./tools.ts";

class CallFailed extends Schema.TaggedError<CallFailed>()("CallFailed", {
  cause: Schema.Defect(),
}) {}

const decodeRead = Schema.decodeUnknownEffect(GerritDirectReadRequest);
const decodeAct = Schema.decodeUnknownEffect(actInput);
const decodeUpload = Schema.decodeUnknownEffect(GerritDirectUploadInput);
const id = ThreadId.make("thread-1");
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "session-1",
  thread: {
    threadId: id,
    providerSessionId: "session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["gerrit"]),
  issuedAt: 1,
};
const harness = Effect.fn("GerritDirectTest.harness")(function* (
  deleted = false,
  missing = false,
  failLink = false,
) {
  const thread = {
    ...Testkit.liveThreadShell(id),
    worktreePath: "/worktree",
    deletedAt: deleted ? DateTime.makeUnsafe("2026-01-01T00:00:00Z") : null,
  };
  const commands: unknown[] = [];
  const deps = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) => {
        commands.push(command);
        if (failLink)
          return Effect.fail(
            new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
            }),
          );
        return Effect.succeed(undefined as never);
      },
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(!missing && threadId === id ? thread : null),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedSome({ workspaceRoot: "/root", deletedAt: null } as never),
    }),
    Layer.mock(GerritDirectRead.GerritDirectRead)({
      read: (input) =>
        Effect.succeed({
          mode: "search",
          changes: [],
          nextCursor: null,
          completeness: "complete",
          input,
          installation: "secret",
        } as never),
    }),
    Layer.mock(GerritDirectService.GerritDirectService)({
      act: (input) =>
        Effect.succeed({
          result: input.action.kind === "topic" ? undefined : input,
          change: { key: { installation: "secret" } },
        } as never),
      upload: (input) =>
        Effect.succeed({
          result: input,
          change: {
            key: { installation: "https://review.example/", project: "team/repo" },
            number: 12,
          },
        } as never),
    }),
  );
  const toolkit = yield* GerritDirectToolkit.pipe(
    Effect.provide(McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(deps))),
  );
  const call = <Name extends keyof typeof GerritDirectToolkit.tools>(
    name: Name,
    input: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, input).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((items) => items.at(-1)!.result),
      // The toolkit reports failures as unknown; tests only need to know a call was refused.
      Effect.mapError((cause) => new CallFailed({ cause })),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provide(deps),
    );
  return { call, commands };
});

describe("direct Gerrit handlers", () => {
  it.effect("reads using the calling checkout and removes internal keys", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const result = yield* h.call("read_gerrit", { mode: "search" });
      expect(result).toMatchObject({ input: { cwd: "/worktree", request: { mode: "search" } } });
      expect(JSON.stringify(result)).not.toContain("installation");
      yield* h.call("read_gerrit", { mode: "diff", target: { number: 12 } }).pipe(
        Effect.match({
          onSuccess: () => {
            throw new Error("Expected missing path to fail");
          },
          onFailure: (invalid) =>
            expect(invalid.cause).toMatchObject({
              message:
                "read_gerrit mode diff requires path. Read mode change for available file paths.",
            }),
        }),
      );
    }),
  );
  it.effect("rejects a deleted thread or a missing project", () =>
    Effect.gen(function* () {
      for (const h of [yield* harness(true), yield* harness(false, true)]) {
        expect(yield* Effect.isFailure(h.call("read_gerrit", { mode: "search" }))).toBe(true);
      }
    }),
  );
  it.effect("acts and uploads from the calling checkout without exposing installation keys", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const act = yield* h.call("act_gerrit", {
        target: { number: 12 },
        action: { kind: "submit" },
      });
      expect(act).toMatchObject({
        result: { cwd: "/worktree", target: { number: 12 } },
        change: { key: {} },
      });
      const upload = yield* h.call("upload_gerrit", { kind: "new", branch: "main" });
      expect(upload).toMatchObject({
        result: { cwd: "/worktree", upload: { kind: "new", branch: "main" } },
      });
      expect(JSON.stringify([act, upload])).not.toContain("installation");
      expect(h.commands).toEqual([
        expect.objectContaining({
          type: "thread.pull-request.link",
          threadId: id,
          host: "review.example",
          repository: "team/repo",
          number: 12,
          url: "https://review.example/c/team/repo/+/12",
        }),
      ]);
    }),
  );
  it.effect("omits a void action result, which MCP cannot encode as JSON", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const act = yield* h.call("act_gerrit", {
        target: { number: 12 },
        action: { kind: "topic", topic: "t" },
      });
      expect(act).toStrictEqual({ change: { key: {} } });
    }),
  );
  it.effect("returns a successful upload with a warning when linking fails", () =>
    Effect.gen(function* () {
      const h = yield* harness(false, false, true);
      const upload = yield* h.call("upload_gerrit", { kind: "new", branch: "main" });
      expect(upload).toMatchObject({
        result: { cwd: "/worktree" },
        linkError: "Upload succeeded, but the change could not be linked to the thread.",
      });
      expect(h.commands).toHaveLength(1);
    }),
  );
  it.effect("rejects unknown fields for all three contracts", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.isFailure(
          decodeRead({ mode: "search", installation: "secret" }, gerritDirectDecodeOptions),
        ),
      ).toBe(true);
      expect(
        yield* Effect.isFailure(
          decodeAct(
            { target: { number: 1 }, action: { kind: "submit", installation: "secret" } },
            gerritDirectDecodeOptions,
          ),
        ),
      ).toBe(true);
      expect(
        yield* Effect.isFailure(
          decodeUpload(
            { kind: "new", branch: "main", installation: "secret" },
            gerritDirectDecodeOptions,
          ),
        ),
      ).toBe(true);
    }),
  );
});
