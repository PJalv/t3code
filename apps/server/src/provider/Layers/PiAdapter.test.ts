// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeAssert from "node:assert/strict";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  PiRpcCommandError,
  type PiRpcClient,
  type PiRpcImage,
  PiRpcProtocolError,
  type PiRpcSpawnOptions,
} from "../pi/PiRpcClient.ts";
import { PI_BRIDGE_PREFIX } from "../pi/PiBridgeProtocol.ts";
import type { PiRpcEvent, PiRpcModel, PiThinkingLevel } from "../pi/PiRpcSchema.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makePiAdapter, type PiAdapterOptions, type PiRpcClientFactory } from "./PiAdapter.ts";

const assert: typeof NodeAssert = NodeAssert;
const fs = NodeFS;
const os = NodeOS;
const path = NodePath;
const instanceId = ProviderInstanceId.make("pi-test");
const modelSelection = createModelSelection(instanceId, "openai/gpt-5", [
  { id: "thinkingLevel", value: "max" },
]);
const JsonUnknown = Schema.fromJsonString(Schema.Unknown);
const encodeUnknownJson = Schema.encodeSync(JsonUnknown);
const bridgeMessage = (payload: unknown) => PI_BRIDGE_PREFIX + encodeUnknownJson(payload);
const decodeBridgeControlCommand = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Number,
      operation: Schema.String,
      requestId: Schema.String,
      agentId: Schema.String,
    }),
  ),
);
type Adapter = ProviderAdapterShape<ProviderAdapterError>;

class FakeClient implements PiRpcClient {
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The synchronous fake exposes its queue through the PiRpcClient stream interface.
  input = Effect.runSync(Queue.unbounded<PiRpcEvent>());
  events: Stream.Stream<PiRpcEvent> = Stream.fromQueue(this.input);
  readonly calls = {
    close: 0,
    abort: 0,
    prompt: 0,
    sessionStats: 0,
    prompts: [] as Array<{
      message: string;
      images: ReadonlyArray<PiRpcImage> | undefined;
      streamingBehavior?: "steer" | "followUp";
    }>,
    thinking: [] as PiThinkingLevel[],
    models: [] as Array<{ provider: string; id: string }>,
    extensionUiResponses: [] as Array<Record<string, unknown>>,
  };
  state: {
    sessionFile?: string;
    sessionId?: string;
    isStreaming?: boolean;
    model?: PiRpcModel;
    thinkingLevel?: PiThinkingLevel;
  } = {};
  getStateResults: Array<typeof this.state> = [];
  availableModels = [
    { provider: "openai", id: "gpt-5", reasoning: true },
    { provider: "openai", id: "gpt-5.1", reasoning: true },
  ];
  failPrompt = false;
  fatalPrompt = false;
  fatalPromptError: PiRpcProtocolError | undefined;
  failExtensionUiResponse = false;
  failGetState = false;
  failThinking = false;
  abortBeforeSettle = false;
  abortEntered: Deferred.Deferred<void> | undefined;
  getStateEntered: Deferred.Deferred<void> | undefined;
  getStateGate: Deferred.Deferred<void> | undefined;
  getAvailableModelsEntered: Deferred.Deferred<void> | undefined;
  getAvailableModelsGate: Deferred.Deferred<void> | undefined;
  setModelEntered: Deferred.Deferred<void> | undefined;
  setModelGate: Deferred.Deferred<void> | undefined;
  setThinkingEntered: Deferred.Deferred<void> | undefined;
  setThinkingGate: Deferred.Deferred<void> | undefined;
  promptEntered: Deferred.Deferred<void> | undefined;
  promptGate: Deferred.Deferred<void> | undefined;
  extensionUiResponseEntered: Deferred.Deferred<void> | undefined;
  extensionUiResponseGate: Deferred.Deferred<void> | undefined;
  closeEntered: Deferred.Deferred<void> | undefined;
  closeGate: Deferred.Deferred<void> | undefined;

  getState = () => {
    const self = this;
    return Effect.gen(function* () {
      if (self.getStateEntered) yield* Deferred.succeed(self.getStateEntered, undefined);
      if (self.getStateGate) yield* Deferred.await(self.getStateGate);
      if (self.failGetState) {
        return yield* new PiRpcProtocolError({ detail: "get_state failed" });
      }
      return self.getStateResults.shift() ?? self.state;
    });
  };
  getAvailableModels = () => {
    const self = this;
    return Effect.gen(function* () {
      if (self.getAvailableModelsEntered)
        yield* Deferred.succeed(self.getAvailableModelsEntered, undefined);
      if (self.getAvailableModelsGate) yield* Deferred.await(self.getAvailableModelsGate);
      return { models: self.availableModels };
    });
  };
  getCommands = () => Effect.succeed({ commands: [] });
  getSessionStats = () =>
    Effect.sync(() => {
      this.calls.sessionStats += 1;
      return {
        sessionId: this.state.sessionId,
        tokens: { input: 100, output: 20, cacheRead: 40, cacheWrite: 0, total: 160 },
        contextUsage: { tokens: 80, contextWindow: 200_000, percent: 0.04 },
      };
    });
  setModel = (provider: string, id: string) => {
    const self = this;
    return Effect.gen(function* () {
      self.calls.models.push({ provider, id });
      if (self.setModelEntered) yield* Deferred.succeed(self.setModelEntered, undefined);
      if (self.setModelGate) yield* Deferred.await(self.setModelGate);
      return { provider, id };
    });
  };
  setThinkingLevel = (level: PiThinkingLevel) => {
    const self = this;
    return Effect.gen(function* () {
      self.calls.thinking.push(level);
      if (self.setThinkingEntered) yield* Deferred.succeed(self.setThinkingEntered, undefined);
      if (self.setThinkingGate) yield* Deferred.await(self.setThinkingGate);
      if (self.failThinking)
        return yield* new PiRpcProtocolError({ detail: "set_thinking_level failed" });
    });
  };
  prompt = (
    message: string,
    images?: ReadonlyArray<PiRpcImage>,
    streamingBehavior?: "steer" | "followUp",
  ) => {
    const self = this;
    return Effect.gen(function* () {
      self.calls.prompt += 1;
      self.calls.prompts.push({
        message,
        images,
        ...(streamingBehavior ? { streamingBehavior } : {}),
      });
      if (self.promptEntered) yield* Deferred.succeed(self.promptEntered, undefined);
      if (self.promptGate) yield* Deferred.await(self.promptGate);
      if (self.failPrompt)
        return yield* new PiRpcCommandError({
          command: "prompt",
          requestId: "test",
          detail: "prompt failed",
        });
      if (self.fatalPrompt) {
        self.fatalPromptError = new PiRpcProtocolError({ detail: "prompt transport failed" });
        return yield* self.fatalPromptError;
      }
    });
  };
  abort = () => {
    const self = this;
    return Effect.gen(function* () {
      self.calls.abort += 1;
      if (self.abortEntered) yield* Deferred.succeed(self.abortEntered, undefined);
      if (self.abortBeforeSettle) yield* Queue.offer(self.input, { type: "agent_settled" });
    });
  };
  respondToExtensionUi = (response: Record<string, unknown>) => {
    const self = this;
    return Effect.gen(function* () {
      if (self.extensionUiResponseEntered)
        yield* Deferred.succeed(self.extensionUiResponseEntered, undefined);
      if (self.extensionUiResponseGate) yield* Deferred.await(self.extensionUiResponseGate);
      if (self.failExtensionUiResponse) {
        return yield* new PiRpcProtocolError({ detail: "extension UI response failed" });
      }
      self.calls.extensionUiResponses.push(response);
    });
  };
  close = () => {
    const self = this;
    return Effect.gen(function* () {
      self.calls.close += 1;
      if (self.closeEntered) yield* Deferred.succeed(self.closeEntered, undefined);
      if (self.closeGate) yield* Deferred.await(self.closeGate);
    });
  };
}

interface Harness {
  readonly client: FakeClient;
  readonly spawns: PiRpcSpawnOptions[];
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly makeClient: PiRpcClientFactory;
  failNextSpawn: boolean;
}

const collectThroughSentinel = Effect.fn("PiAdapterTest.collectThroughSentinel")(function* (
  adapter: Adapter,
) {
  let sentinelTurnId: string | undefined;
  const collected = yield* adapter.streamEvents.pipe(
    Stream.takeUntil((event) => event.type === "turn.completed" && event.turnId === sentinelTurnId),
    Stream.runCollect,
    Effect.forkChild,
  );
  return {
    collected,
    setSentinel: (turnId: string) => {
      sentinelTurnId = turnId;
    },
  };
});

const makeHarness = (harnessOptions: { readonly failStart?: boolean } = {}): Harness => {
  const client = new FakeClient();
  const spawns: PiRpcSpawnOptions[] = [];
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pi-adapter-"));
  const attachmentsDir = path.join(stateDir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const harness: Harness = {
    client,
    spawns,
    stateDir,
    attachmentsDir,
    failNextSpawn: false,
    makeClient: (spawnOptions) =>
      Effect.gen(function* () {
        spawns.push(spawnOptions);
        if (harnessOptions.failStart || harness.failNextSpawn) {
          harness.failNextSpawn = false;
          return yield* new PiRpcCommandError({
            command: "spawn",
            requestId: "test",
            detail: "spawn failed",
          });
        }
        const sessionIndex = spawnOptions.args?.indexOf("--session") ?? -1;
        const sessionFile = spawnOptions.args?.[sessionIndex + 1];
        assert.ok(sessionFile);
        const sessionId = "pi-generated-session-id";
        fs.writeFileSync(
          sessionFile,
          `{"type":"session","id":"${sessionId}","cwd":"${spawnOptions.cwd}"}\n`,
        );
        client.state = { ...client.state, sessionFile, sessionId };
        return client;
      }),
  };
  return harness;
};

const withAdapter = <A>(
  harness: Harness,
  use: (adapter: Adapter) => Effect.Effect<A, ProviderAdapterError>,
  adapterOptions: Partial<Pick<PiAdapterOptions, "readAttachment" | "onBeforePrompt">> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter({
        binaryPath: "pi",
        providerInstanceId: instanceId,
        stateDir: harness.stateDir,
        attachmentsDir: harness.attachmentsDir,
        makeRpcClient: harness.makeClient,
        ...adapterOptions,
      });
      return yield* use(adapter);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const start = (adapter: Adapter, id = "thread") =>
  adapter.startSession({
    provider: ProviderDriverKind.make("pi"),
    providerInstanceId: instanceId,
    threadId: ThreadId.make(id),
    cwd: process.cwd(),
    runtimeMode: "full-access",
  });

const cancelAtClientPreflight = (stage: "models" | "model" | "thinking") => {
  const h = makeHarness();
  return withAdapter(h, (adapter) =>
    Effect.gen(function* () {
      yield* start(adapter);
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      if (stage === "models") {
        h.client.getAvailableModelsEntered = entered;
        h.client.getAvailableModelsGate = gate;
      } else if (stage === "model") {
        h.client.setModelEntered = entered;
        h.client.setModelGate = gate;
      } else {
        h.client.setThinkingEntered = entered;
        h.client.setThinkingGate = gate;
      }
      const sending = yield* adapter
        .sendTurn({
          threadId: ThreadId.make("thread"),
          input: `cancel during ${stage}`,
          modelSelection,
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* adapter.interruptTurn(ThreadId.make("thread"));
      const result = yield* Fiber.join(sending);
      assert.equal(result._tag, "Failure");
      assert.equal(h.client.calls.prompt, 0);
      const session = (yield* adapter.listSessions())[0];
      assert.equal(session?.status, "ready");
      assert.equal(session?.activeTurnId, undefined);
      assert.equal(h.client.calls.close, 0);
    }),
  );
};

describe("PiAdapter", () => {
  it.effect("allocates an exact durable session and rejects non-full-access before spawn", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const rejected = yield* adapter
          .startSession({
            threadId: ThreadId.make("rejected"),
            runtimeMode: "approval-required",
          })
          .pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
        if (rejected._tag === "Failure")
          assert.equal(rejected.failure._tag, "ProviderAdapterValidationError");
        assert.equal(h.spawns.length, 0);

        const session = yield* start(adapter);
        const cursor = session.resumeCursor as {
          schemaVersion: number;
          sessionFile: string;
          sessionId: string;
        };
        assert.equal(cursor.schemaVersion, 1);
        assert.equal(h.client.state.sessionFile, cursor.sessionFile);
        assert.equal(h.client.state.sessionId, cursor.sessionId);
        const args = h.spawns[0]?.args ?? [];
        assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), [
          "--session",
          cursor.sessionFile,
        ]);
        assert.equal(args.includes("--no-session"), false);
        assert.equal(args.includes("--offline"), true);
        const extensionIndex = args.indexOf("--extension");
        assert.ok(extensionIndex >= 0);
        assert.match(args[extensionIndex + 1] ?? "", /t3code-pi-bridge\.mjs$/u);
        assert.equal(h.spawns[0]?.env?.T3CODE_PI_BRIDGE, "1");
        for (const arg of [
          "--no-context-files",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
        ])
          assert.equal(args.includes(arg), false);
      }),
    );
  });

  it.effect("spawns Pi from the thread working directory", () => {
    const h = makeHarness();
    const cwd = path.join(h.stateDir, "workspace");
    fs.mkdirSync(cwd);
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: instanceId,
          threadId: ThreadId.make("thread"),
          cwd,
          runtimeMode: "full-access",
        });
        assert.equal(h.spawns[0]?.cwd, cwd);
      }),
    );
  });

  it.effect("injects T3 browser MCP into the Pi process without changing project config", () => {
    const h = makeHarness();
    const threadId = ThreadId.make("mcp-thread");
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment"),
      threadId,
      providerSessionId: "provider-session",
      providerInstanceId: instanceId,
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-token",
    });
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: instanceId,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const args = h.spawns[0]?.args ?? [];
        assert.equal(args.includes("--mcp-config"), false);
        const configFile = h.spawns[0]?.env?.T3CODE_PI_MCP_CONFIG;
        assert.ok(configFile);
        assert.equal(path.resolve(configFile).startsWith(path.resolve(h.stateDir)), true);
        assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
        const config = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ mcpServers: Schema.Record(Schema.String, Schema.Unknown) }),
          ),
        )(fs.readFileSync(configFile, "utf8")).pipe(Effect.orDie);
        assert.deepEqual(config.mcpServers["t3-code"], {
          url: "http://127.0.0.1:43123/mcp",
          headers: { Authorization: "Bearer secret-token" },
          lifecycle: "keep-alive",
        });
        yield* adapter.stopSession(threadId);
        assert.equal(fs.existsSync(configFile), false);
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );
  });

  it.effect("sends persisted image attachments through Pi RPC", () => {
    const h = makeHarness();
    const attachmentId = "thread-image";
    fs.writeFileSync(path.join(h.attachmentsDir, `${attachmentId}.png`), Buffer.from("image"));
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          modelSelection,
        });
        assert.deepEqual(h.client.calls.prompts, [
          {
            message: "",
            images: [
              {
                type: "image",
                data: Buffer.from("image").toString("base64"),
                mimeType: "image/png",
              },
            ],
          },
        ]);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("settles extension slash commands that do not start an agent", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const turn = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "/workflows",
          modelSelection,
        });
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepEqual(
          events.map((event) => event.type),
          ["turn.started", "turn.completed"],
        );
        assert.equal(events[1]?.turnId, turn.turnId);
      }),
    );
  });

  it.effect("ignores informational extension notices but preserves warnings", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const warningFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "runtime.warning" }> =>
              event.type === "runtime.warning",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Queue.offer(h.client.input, {
          type: "extension_ui_request",
          id: "mcp-ready",
          method: "notify",
          message: "MCP: 1 servers connected (29 tools)",
          notifyType: "info",
        });
        yield* Queue.offer(h.client.input, {
          type: "extension_ui_request",
          id: "mcp-warning",
          method: "notify",
          message: "MCP connection is degraded",
          notifyType: "warning",
        });
        const warning = yield* Fiber.join(warningFiber);
        assert.equal(Option.isSome(warning), true);
        if (Option.isSome(warning))
          assert.equal(warning.value.payload.message, "MCP connection is degraded");
      }),
    );
  });

  it.effect("answers extension UI requests while prompt preflight is waiting", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        h.client.promptEntered = yield* Deferred.make<void>();
        h.client.promptGate = yield* Deferred.make<void>();
        const requestedFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "user-input.requested" }> =>
              event.type === "user-input.requested",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        const sendFiber = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "ask first",
            modelSelection,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(h.client.promptEntered);
        yield* Queue.offer(h.client.input, {
          type: "extension_ui_request",
          id: "confirm-1",
          method: "confirm",
          title: "Approve command",
          message: "Run the command?",
        });
        const requested = yield* Fiber.join(requestedFiber);
        assert.equal(Option.isSome(requested), true);
        if (Option.isNone(requested)) return;
        const question = requested.value.payload.questions[0];
        assert.equal(question?.question, "Run the command?");
        assert.deepEqual(
          question?.options.map((option) => option.label),
          ["Yes", "No"],
        );
        yield* adapter.respondToUserInput(
          ThreadId.make("thread"),
          ApprovalRequestId.make(String(requested.value.requestId)),
          { [question!.id]: "Yes" },
        );
        assert.deepEqual(h.client.calls.extensionUiResponses, [
          { id: "confirm-1", confirmed: true },
        ]);
        yield* Deferred.succeed(h.client.promptGate, undefined);
        yield* Fiber.join(sendFiber);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("keeps extension input pending until Pi accepts the response", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        h.client.promptEntered = yield* Deferred.make<void>();
        h.client.promptGate = yield* Deferred.make<void>();
        const requestedFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "user-input.requested" }> =>
              event.type === "user-input.requested",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        const sendFiber = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "ask first",
            modelSelection,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(h.client.promptEntered);
        yield* Queue.offer(h.client.input, {
          type: "extension_ui_request",
          id: "confirm-retry",
          method: "confirm",
          title: "Approve command",
          message: "Run the command?",
        });
        const requested = yield* Fiber.join(requestedFiber);
        assert.equal(Option.isSome(requested), true);
        if (Option.isNone(requested)) return;
        const question = requested.value.payload.questions[0]!;
        const requestId = ApprovalRequestId.make(String(requested.value.requestId));
        h.client.failExtensionUiResponse = true;
        const failed = yield* adapter
          .respondToUserInput(ThreadId.make("thread"), requestId, { [question.id]: "Yes" })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        h.client.failExtensionUiResponse = false;
        yield* adapter.respondToUserInput(ThreadId.make("thread"), requestId, {
          [question.id]: "Yes",
        });
        assert.deepEqual(h.client.calls.extensionUiResponses, [
          { id: "confirm-retry", confirmed: true },
        ]);
        yield* Deferred.succeed(h.client.promptGate, undefined);
        yield* Fiber.join(sendFiber);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("sends one response when extension input resolution overlaps", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const requestedFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "user-input.requested" }> =>
              event.type === "user-input.requested",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Queue.offer(h.client.input, {
          type: "extension_ui_request",
          id: "confirm-overlap",
          method: "confirm",
          title: "Approve command",
          message: "Run the command?",
        });
        const requested = yield* Fiber.join(requestedFiber);
        assert.equal(Option.isSome(requested), true);
        if (Option.isNone(requested)) return;
        const question = requested.value.payload.questions[0]!;
        const requestId = ApprovalRequestId.make(String(requested.value.requestId));
        h.client.extensionUiResponseEntered = yield* Deferred.make<void>();
        h.client.extensionUiResponseGate = yield* Deferred.make<void>();
        const firstResponse = yield* adapter
          .respondToUserInput(ThreadId.make("thread"), requestId, { [question.id]: "Yes" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(h.client.extensionUiResponseEntered);
        const overlapping = yield* adapter
          .respondToUserInput(ThreadId.make("thread"), requestId, { [question.id]: "Yes" })
          .pipe(Effect.result);
        assert.equal(overlapping._tag, "Failure");
        yield* Deferred.succeed(h.client.extensionUiResponseGate, undefined);
        yield* Fiber.join(firstResponse);
        assert.deepEqual(h.client.calls.extensionUiResponses, [
          { id: "confirm-overlap", confirmed: true },
        ]);
      }),
    );
  });

  it.effect("interrupts and stops while prompt preflight is blocked", () => {
    const interruptHarness = makeHarness();
    return withAdapter(interruptHarness, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        interruptHarness.client.promptEntered = yield* Deferred.make<void>();
        interruptHarness.client.promptGate = yield* Deferred.make<void>();
        interruptHarness.client.abortEntered = yield* Deferred.make<void>();
        const sending = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "blocked prompt",
            modelSelection,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(interruptHarness.client.promptEntered);
        const turnId = (yield* adapter.listSessions())[0]?.activeTurnId;
        const interrupting = yield* adapter
          .interruptTurn(ThreadId.make("thread"), turnId)
          .pipe(Effect.forkChild);
        yield* Deferred.await(interruptHarness.client.abortEntered);
        yield* Fiber.join(interrupting);
        yield* Deferred.succeed(interruptHarness.client.promptGate, undefined);
        yield* Fiber.join(sending);
        yield* Queue.offer(interruptHarness.client.input, { type: "agent_settled" });
      }),
    ).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const stopHarness = makeHarness();
          return withAdapter(stopHarness, (adapter) =>
            Effect.gen(function* () {
              yield* start(adapter);
              stopHarness.client.promptEntered = yield* Deferred.make<void>();
              stopHarness.client.promptGate = yield* Deferred.make<void>();
              stopHarness.client.closeEntered = yield* Deferred.make<void>();
              const sending = yield* adapter
                .sendTurn({
                  threadId: ThreadId.make("thread"),
                  input: "blocked prompt",
                  modelSelection,
                })
                .pipe(Effect.result, Effect.forkChild);
              yield* Deferred.await(stopHarness.client.promptEntered);
              const stopping = yield* adapter
                .stopSession(ThreadId.make("thread"))
                .pipe(Effect.forkChild);
              yield* Deferred.await(stopHarness.client.closeEntered);
              yield* Fiber.join(stopping);
              yield* Deferred.succeed(stopHarness.client.promptGate, undefined);
              const result = yield* Fiber.join(sending);
              assert.equal(result._tag, "Failure");
            }),
          );
        }),
      ),
    );
  });

  it.effect("cancels attachment preparation without starting a turn", () => {
    const h = makeHarness();
    const entered = Effect.runSync(Deferred.make<void>());
    const gate = Effect.runSync(Deferred.make<void>());
    let blockRead = true;
    return withAdapter(
      h,
      (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const sending = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              attachments: [
                {
                  type: "image",
                  id: "cancelled-image",
                  name: "cancelled.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
              modelSelection,
            })
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* adapter.interruptTurn(ThreadId.make("thread"));
          const result = yield* Fiber.join(sending);
          assert.equal(result._tag, "Failure");
          assert.equal(h.client.calls.prompt, 0);
          assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
          blockRead = false;
          yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "next turn succeeds",
            modelSelection,
          });
          assert.equal(h.client.calls.prompt, 1);
          yield* Queue.offer(h.client.input, { type: "agent_settled" });
        }),
      {
        readAttachment: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            if (blockRead) yield* Deferred.await(gate);
            return new Uint8Array(Buffer.from("image"));
          }),
      },
    );
  });

  it.effect("cancels model discovery without starting a turn", () =>
    cancelAtClientPreflight("models"),
  );

  it.effect("cancels model and thinking mutation without submitting a prompt", () =>
    cancelAtClientPreflight("model").pipe(
      Effect.andThen(Effect.suspend(() => cancelAtClientPreflight("thinking"))),
    ),
  );

  it.effect("cancels the final prompt handoff idempotently and allows the next turn", () => {
    const h = makeHarness();
    const entered = Effect.runSync(Deferred.make<void>());
    const gate = Effect.runSync(Deferred.make<void>());
    let blockHandoff = true;
    return withAdapter(
      h,
      (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const sending = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              input: "cancel before prompt",
              modelSelection,
            })
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* adapter.interruptTurn(ThreadId.make("thread"));
          yield* adapter.interruptTurn(ThreadId.make("thread"));
          yield* Deferred.succeed(gate, undefined);
          const result = yield* Fiber.join(sending);
          assert.equal(result._tag, "Failure");
          assert.equal(h.client.calls.prompt, 0);
          assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
          blockHandoff = false;
          yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "next turn succeeds",
            modelSelection,
          });
          assert.equal(h.client.calls.prompt, 1);
          yield* Queue.offer(h.client.input, { type: "agent_settled" });
        }),
      {
        onBeforePrompt: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            if (blockHandoff) yield* Deferred.await(gate);
          }),
      },
    );
  });

  it.effect("projects Pi built-in tools into useful canonical tool call details", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 7).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "inspect and edit",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "bash-1",
            toolName: "bash",
            args: { command: "git status --short" },
          },
          {
            type: "tool_execution_update",
            toolCallId: "bash-1",
            toolName: "bash",
            args: { command: "git status --short" },
            partialResult: {
              content: [{ type: "text", text: " M apps/server/src/provider/Layers/PiAdapter.ts" }],
              details: { truncation: null },
            },
          },
          {
            type: "tool_execution_end",
            toolCallId: "bash-1",
            toolName: "bash",
            result: {
              content: [{ type: "text", text: " M apps/server/src/provider/Layers/PiAdapter.ts" }],
              details: { truncation: null },
            },
            isError: false,
          },
          {
            type: "tool_execution_start",
            toolCallId: "edit-1",
            toolName: "edit",
            args: { path: "src/app.ts", oldText: "old", newText: "new" },
          },
          {
            type: "tool_execution_update",
            toolCallId: "edit-1",
            toolName: "edit",
            args: { path: "src/app.ts", oldText: "old", newText: "new" },
            partialResult: { content: [{ type: "text", text: "Editing src/app.ts" }] },
          },
          {
            type: "tool_execution_end",
            toolCallId: "edit-1",
            toolName: "edit",
            result: {
              content: [{ type: "text", text: "Successfully replaced text in src/app.ts" }],
              details: { diff: "-old\n+new" },
            },
            isError: false,
          },
        ]);

        const events = Array.from(yield* Fiber.join(collected));
        const tools = events.filter(
          (
            event,
          ): event is Extract<
            ProviderRuntimeEvent,
            { type: "item.started" | "item.updated" | "item.completed" }
          > =>
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed",
        );
        assert.equal(tools.length, 6);
        assert.deepEqual(tools[2]?.payload, {
          itemType: "command_execution",
          title: "Ran command",
          status: "completed",
          data: {
            toolCallId: "bash-1",
            toolName: "bash",
            kind: "execute",
            command: "git status --short",
            rawInput: { command: "git status --short" },
            rawOutput: {
              content: "M apps/server/src/provider/Layers/PiAdapter.ts",
              truncation: null,
            },
            item: { input: { command: "git status --short" } },
          },
        });
        assert.deepEqual(tools[5]?.payload, {
          itemType: "file_change",
          title: "Edited file",
          detail: "src/app.ts",
          status: "completed",
          data: {
            toolCallId: "edit-1",
            toolName: "edit",
            kind: "edit",
            rawInput: { path: "src/app.ts", oldText: "old", newText: "new" },
            rawOutput: {
              content: "Successfully replaced text in src/app.ts",
              diff: "-old\n+new",
            },
            item: {
              input: { path: "src/app.ts", oldText: "old", newText: "new" },
              changes: [{ path: "src/app.ts" }],
            },
          },
        });
      }),
    );
  });

  it.effect("emits cumulative provider-native diffs for Pi write and edit tools", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.diff.updated"),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "write and edit",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "write-1",
            toolName: "write",
            args: { path: "src/app.ts", content: "old\n" },
          },
          {
            type: "tool_execution_end",
            toolCallId: "write-1",
            toolName: "write",
            result: { content: [{ type: "text", text: "Successfully wrote src/app.ts" }] },
            isError: false,
          },
          {
            type: "tool_execution_start",
            toolCallId: "edit-1",
            toolName: "edit",
            args: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] },
          },
          {
            type: "tool_execution_end",
            toolCallId: "edit-1",
            toolName: "edit",
            result: {
              content: [{ type: "text", text: "Successfully replaced src/app.ts" }],
              details: {
                patch: "--- src/app.ts\n+++ src/app.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
              },
            },
            isError: false,
          },
        ]);

        const events = Array.from(yield* Fiber.join(collected));
        const writePatch = [
          "Index: src/app.ts",
          "===================================================================",
          "--- /dev/null",
          "+++ src/app.ts",
          "@@ -0,0 +1,1 @@",
          "+old",
        ].join("\n");
        const editPatch = [
          "Index: src/app.ts",
          "===================================================================",
          "--- src/app.ts",
          "+++ src/app.ts",
          "@@ -1,1 +1,1 @@",
          "-old",
          "+new",
        ].join("\n");
        assert.equal(events[0]?.type, "turn.diff.updated");
        assert.equal(events[1]?.type, "turn.diff.updated");
        if (events[0]?.type === "turn.diff.updated") {
          assert.equal(events[0].payload.unifiedDiff, writePatch);
        }
        if (events[1]?.type === "turn.diff.updated") {
          assert.equal(events[1].payload.unifiedDiff, `${writePatch}\n${editPatch}`);
        }
      }),
    );
  });

  it.effect("classifies Pi agent-backed tools as collaboration work", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 4).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "delegate this",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "agent-1",
            toolName: "security_scout",
            args: { query: "Locate the authentication flow" },
          },
          {
            type: "tool_execution_update",
            toolCallId: "agent-1",
            toolName: "security_scout",
            partialResult: {
              content: [{ type: "text", text: "Searching" }],
              details: { agent: "security_scout", task: "Locate the authentication flow" },
            },
          },
          {
            type: "tool_execution_end",
            toolCallId: "agent-1",
            toolName: "security_scout",
            result: {
              content: [{ type: "text", text: "Found the flow" }],
              details: { agent: "security_scout", task: "Locate the authentication flow" },
            },
            isError: false,
          },
        ]);

        const events = Array.from(yield* Fiber.join(collected));
        const tools = events.filter(
          (
            event,
          ): event is Extract<
            ProviderRuntimeEvent,
            { type: "item.started" | "item.updated" | "item.completed" }
          > =>
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed",
        );
        assert.equal(tools.length, 3);
        assert.equal(tools[0]?.payload.itemType, "dynamic_tool_call");
        for (const event of tools.slice(1)) {
          assert.equal(event.payload.itemType, "collab_agent_tool_call");
          assert.equal(event.payload.title, "Security scout agent");
          assert.equal(event.payload.detail, "Locate the authentication flow");
          assert.equal(
            (event.payload.data as Record<string, unknown> | undefined)?.toolName,
            "security_scout",
          );
        }
      }),
    );
  });

  it.effect("projects the current Pi subagent extension into task lifecycle events", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const stream = yield* collectThroughSentinel(adapter);
        const turn = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "delegate in parallel",
          modelSelection,
        });
        stream.setSentinel(turn.turnId);
        const running = {
          mode: "parallel",
          agentScope: "user",
          projectAgentsDir: null,
          results: [
            {
              agent: "scout",
              agentSource: "user",
              task: "Find the auth flow",
              exitCode: -1,
              messages: [],
              stderr: "",
              model: "openai/gpt-5",
              usage: {
                input: 30,
                output: 4,
                cacheRead: 20,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 34,
                turns: 1,
              },
            },
          ],
        };
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "subagent-1",
            toolName: "subagent",
            args: { tasks: [{ agent: "scout", task: "Find the auth flow" }] },
          },
          {
            type: "tool_execution_update",
            toolCallId: "subagent-1",
            toolName: "subagent",
            partialResult: { content: [{ type: "text", text: "running" }], details: running },
          },
          {
            type: "tool_execution_end",
            toolCallId: "subagent-1",
            toolName: "subagent",
            result: {
              content: [{ type: "text", text: "Parallel: 1/1 succeeded" }],
              details: {
                ...running,
                results: [{ ...running.results[0], exitCode: 0 }],
              },
            },
            isError: false,
          },
          { type: "agent_settled" },
        ]);

        const events = Array.from(yield* Fiber.join(stream.collected));
        const tasks = events.filter(
          (
            event,
          ): event is Extract<
            ProviderRuntimeEvent,
            { type: "task.started" | "task.progress" | "task.completed" }
          > =>
            event.type === "task.started" ||
            event.type === "task.progress" ||
            event.type === "task.completed",
        );
        assert.deepEqual(
          tasks.map((event) => event.type),
          ["task.started", "task.progress", "task.completed"],
        );
        assert.equal(new Set(tasks.map((event) => event.payload.taskId)).size, 1);
        assert.deepEqual(
          tasks.map((event) => event.createdAt),
          tasks.map((event) => event.createdAt).toSorted(),
        );
        assert.equal(new Set(tasks.map((event) => event.createdAt)).size, tasks.length);
        assert.equal(tasks[0]?.payload.title, "scout");
        assert.equal(tasks[0]?.payload.model, "openai/gpt-5");
        const completed = tasks[2] as Extract<ProviderRuntimeEvent, { type: "task.completed" }>;
        assert.equal(completed.payload.status, "completed");
        assert.deepEqual(completed.payload.typedUsage, {
          totalTokens: 34,
          inputTokens: 30,
          outputTokens: 4,
          cachedInputTokens: 20,
        });
      }),
    );
  });

  it.effect("classifies pi-mcp-adapter proxy and direct calls as MCP tools", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const stream = yield* collectThroughSentinel(adapter);
        const turn = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "use MCP",
          modelSelection,
        });
        stream.setSentinel(turn.turnId);
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "mcp-proxy",
            toolName: "mcp",
            args: { tool: "github_search", server: "github", args: "{}" },
          },
          {
            type: "tool_execution_end",
            toolCallId: "mcp-proxy",
            toolName: "mcp",
            result: {
              content: [{ type: "text", text: "found" }],
              details: { mode: "call", server: "github", tool: "search" },
            },
            isError: false,
          },
          {
            type: "tool_execution_start",
            toolCallId: "mcp-direct",
            toolName: "github_get_issue",
            args: { issue: 42 },
          },
          {
            type: "tool_execution_end",
            toolCallId: "mcp-direct",
            toolName: "github_get_issue",
            result: {
              content: [{ type: "text", text: "issue" }],
              details: { server: "github", tool: "get_issue" },
            },
            isError: false,
          },
          { type: "agent_settled" },
        ]);

        const events = Array.from(yield* Fiber.join(stream.collected));
        const items = events.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
            event.type === "item.completed",
        );
        assert.equal(items[0]?.payload.itemType, "mcp_tool_call");
        assert.equal(items[0]?.payload.title, "MCP: github_search");
        assert.equal(items[0]?.payload.detail, "github");
        assert.equal(items[1]?.payload.itemType, "mcp_tool_call");
        assert.equal(items[1]?.payload.title, "MCP: get_issue");
      }),
    );
  });

  it.effect("settles Pi subagent tasks cleanly when their tool is aborted", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "delegate this",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "subagent-abort",
            toolName: "subagent",
            args: { tasks: [{ agent: "default", task: "Long task" }] },
          },
          {
            type: "tool_execution_update",
            toolCallId: "subagent-abort",
            toolName: "subagent",
            partialResult: {
              content: [{ type: "text", text: "running" }],
              details: {
                mode: "parallel",
                results: [
                  {
                    agent: "default",
                    agentSource: "user",
                    task: "Long task",
                    exitCode: -1,
                    model: "cliproxy-group/glm-5.2",
                    usage: {},
                  },
                ],
              },
            },
          },
        ]);
        yield* adapter.interruptTurn(ThreadId.make("thread"));
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_end",
            toolCallId: "subagent-abort",
            toolName: "subagent",
            result: { content: [{ type: "text", text: "Subagent was aborted" }] },
            isError: true,
          },
          {
            type: "message_update",
            assistantMessageEvent: { type: "error", reason: "The operation was aborted." },
          },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "The operation was aborted.",
            },
          },
          { type: "agent_settled" },
        ]);

        const events = Array.from(yield* Fiber.join(collected));
        assert.equal(
          events.some((event) => event.type === "runtime.error"),
          false,
        );
        const completedTask = events.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
            event.type === "task.completed",
        );
        assert.equal(completedTask?.payload.status, "stopped");
        assert.equal(completedTask?.payload.role, "user");
        const completedTurn = events.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed",
        );
        assert.equal(completedTurn?.payload.state, "interrupted");
      }),
    );
  });

  it.effect("interrupts Pi subagents after the parent turn has settled", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const settled = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        const parent = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "delegate this",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "spawn-background",
            toolName: "subagent_spawn",
            args: { name: "Long review", harness: "pi" },
          },
          {
            type: "tool_execution_end",
            toolCallId: "spawn-background",
            toolName: "subagent_spawn",
            result: {
              content: [{ type: "text", text: "Spawned sa-background" }],
              details: { id: "sa-background", title: "Long review", harness: "pi" },
            },
            isError: false,
          },
          { type: "agent_settled" },
        ]);
        yield* Fiber.join(settled);

        const stale = yield* adapter
          .interruptTurn(ThreadId.make("thread"), TurnId.make(`${parent.turnId}-stale`))
          .pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        assert.equal(h.client.calls.abort, 0);
        yield* adapter.interruptTurn(ThreadId.make("thread"));
        assert.equal(h.client.calls.abort, 1);
      }),
    );
  });

  it.effect("projects background subagents into task lifecycle events and a follow-up turn", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        let completedTurns = 0;
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => {
            if (event.type !== "turn.completed") return false;
            completedTurns += 1;
            return completedTurns === 2;
          }),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "delegate this",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "spawn-1",
            toolName: "subagent_spawn",
            args: {
              name: "Security review",
              harness: "pi",
              model: "openai/gpt-5",
              reasoning_effort: "high",
            },
          },
          {
            type: "tool_execution_end",
            toolCallId: "spawn-1",
            toolName: "subagent_spawn",
            result: {
              content: [{ type: "text", text: "Spawned sa-1" }],
              details: {
                id: "sa-1",
                title: "Security review",
                harness: "pi",
                model: "openai/gpt-5",
              },
            },
            isError: false,
          },
          { type: "agent_settled" },
          { type: "agent_start" },
          {
            type: "message_end",
            message: {
              role: "custom",
              customType: "subagent-result",
              content: "Subagent sa-1 finished.",
              details: { id: "sa-1", title: "Security review", status: "done" },
            },
          },
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "Review complete" },
          },
          { type: "agent_settled" },
        ]);

        const events = Array.from(yield* Fiber.join(collected));
        const tasks = events.filter(
          (
            event,
          ): event is Extract<
            ProviderRuntimeEvent,
            { type: "task.started" | "task.progress" | "task.completed" }
          > =>
            event.type === "task.started" ||
            event.type === "task.progress" ||
            event.type === "task.completed",
        );
        assert.deepEqual(
          tasks.map((event) => event.type),
          ["task.started", "task.progress", "task.completed"],
        );
        assert.equal(new Set(tasks.map((event) => event.payload.taskId)).size, 1);
        const started = tasks.find((event) => event.type === "task.started");
        const completed = tasks.find((event) => event.type === "task.completed");
        assert.equal(started?.payload.title, "Security review");
        assert.equal(started?.payload.role, "pi");
        assert.equal(completed?.payload.status, "completed");
        assert.equal(events.filter((event) => event.type === "turn.started").length, 2);
        assert.equal(
          events.some(
            (event) => event.type === "content.delta" && event.payload.delta === "Review complete",
          ),
          true,
        );
      }),
    );
  });

  it.effect("projects async Agent extension tasks and grouped completion notifications", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        let completedTurns = 0;
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => {
            if (event.type !== "turn.completed") return false;
            completedTurns += 1;
            return completedTurns === 2;
          }),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "launch background agents",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "agent-fast",
            toolName: "Agent",
            args: {
              description: "Immediate hello",
              subagent_type: "luna",
              run_in_background: true,
              prompt: "Reply immediately",
            },
          },
          {
            type: "tool_execution_end",
            toolCallId: "agent-fast",
            toolName: "Agent",
            result: {
              content: [{ type: "text", text: "Agent started in background." }],
              details: {
                displayName: "luna",
                description: "Immediate hello",
                subagentType: "luna",
                status: "background",
                agentId: "async-fast",
              },
            },
            isError: false,
          },
          {
            type: "tool_execution_start",
            toolCallId: "agent-slow",
            toolName: "Agent",
            args: {
              description: "Delayed hello",
              subagent_type: "luna",
              run_in_background: true,
              prompt: "Sleep before replying",
            },
          },
          {
            type: "tool_execution_end",
            toolCallId: "agent-slow",
            toolName: "Agent",
            result: {
              content: [{ type: "text", text: "Agent started in background." }],
              details: {
                displayName: "luna",
                description: "Delayed hello",
                subagentType: "luna",
                status: "background",
                agentId: "async-slow",
              },
            },
            isError: false,
          },
          { type: "agent_settled" },
          { type: "agent_start" },
          {
            type: "message_end",
            message: {
              role: "custom",
              customType: "subagent-notification",
              content: "Background agent group completed: 2 agent(s) finished",
              details: {
                id: "async-fast",
                description: "Immediate hello",
                status: "completed",
                toolUses: 2,
                totalTokens: 120,
                durationMs: 500,
                resultPreview: "Hello from A",
                others: [
                  {
                    id: "async-slow",
                    description: "Delayed hello",
                    status: "error",
                    toolUses: 3,
                    totalTokens: 180,
                    durationMs: 30_500,
                    error: "Agent B failed",
                    resultPreview: "Partial output from B",
                  },
                ],
              },
            },
          },
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "Both agents finished" },
          },
          { type: "agent_settled" },
        ]);

        const events = Array.from(yield* Fiber.join(collected));
        const tasks = events.filter(
          (
            event,
          ): event is Extract<
            ProviderRuntimeEvent,
            { type: "task.started" | "task.progress" | "task.completed" }
          > =>
            event.type === "task.started" ||
            event.type === "task.progress" ||
            event.type === "task.completed",
        );
        assert.deepEqual(
          tasks.map((event) => event.type),
          [
            "task.started",
            "task.progress",
            "task.started",
            "task.progress",
            "task.completed",
            "task.completed",
          ],
        );
        assert.equal(new Set(tasks.map((event) => event.payload.taskId)).size, 2);
        const started = tasks.filter((event) => event.type === "task.started");
        assert.deepEqual(
          started.map((event) => [event.payload.title, event.payload.role]),
          [
            ["Immediate hello", "luna"],
            ["Delayed hello", "luna"],
          ],
        );
        const completed = tasks.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
            event.type === "task.completed",
        );
        assert.deepEqual(
          completed.map((event) => [
            event.payload.status,
            event.payload.summary,
            event.payload.typedUsage,
          ]),
          [
            ["completed", "Hello from A", { totalTokens: 120, toolUses: 2, durationMs: 500 }],
            ["failed", "Agent B failed", { totalTokens: 180, toolUses: 3, durationMs: 30_500 }],
          ],
        );
        const agentItems = events.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
            event.type === "item.completed" && event.payload.title === "Luna agent",
        );
        assert.equal(agentItems.length, 2);
        assert.equal(
          agentItems.every((event) => event.payload.itemType === "collab_agent_tool_call"),
          true,
        );
        assert.equal(events.filter((event) => event.type === "turn.started").length, 2);
      }),
    );
  });

  it.effect("uses bridge lifecycle to settle detached Agent tasks without a follow-up turn", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "task.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "launch bridge agent",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "extension_ui_request",
            id: "bridge-ready",
            method: "notify",
            message: bridgeMessage({
              version: 1,
              kind: "bridge.ready",
              subagentsRpcVersion: 2,
              targetedStop: true,
            }),
          },
          {
            type: "tool_execution_start",
            toolCallId: "agent-bridge",
            toolName: "Agent",
            args: { description: "Bridge agent", subagent_type: "luna" },
          },
          {
            type: "tool_execution_end",
            toolCallId: "agent-bridge",
            toolName: "Agent",
            result: {
              content: [{ type: "text", text: "Agent started in background." }],
              details: {
                description: "Bridge agent",
                subagentType: "luna",
                status: "background",
                agentId: "bridge-agent-id",
              },
            },
            isError: false,
          },
          { type: "agent_settled" },
          {
            type: "extension_ui_request",
            id: "bridge-completed",
            method: "notify",
            message: bridgeMessage({
              version: 1,
              kind: "task.completed",
              invocationId: "agent-bridge",
              agentId: "bridge-agent-id",
              title: "Bridge agent",
              role: "luna",
              status: "completed",
              summary: "Bridge result",
              usage: { totalTokens: 321, toolUses: 4, durationMs: 900 },
            }),
          },
        ]);
        const events = Array.from(yield* Fiber.join(collected));
        const completed = events.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
            event.type === "task.completed",
        );
        assert.equal(completed?.payload.status, "completed");
        assert.equal(completed?.payload.summary, "Bridge result");
        assert.deepEqual(completed?.payload.typedUsage, {
          totalTokens: 321,
          toolUses: 4,
          durationMs: 900,
        });
        assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
      }),
    );
  });

  it.effect("stops a detached Agent through the bridge and trusts the acknowledgement", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const settled = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "launch stoppable agent",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "extension_ui_request",
            id: "bridge-ready-stop",
            method: "notify",
            message: bridgeMessage({
              version: 1,
              kind: "bridge.ready",
              subagentsRpcVersion: 2,
              targetedStop: true,
            }),
          },
          {
            type: "tool_execution_start",
            toolCallId: "agent-stop",
            toolName: "Agent",
            args: { description: "Stoppable agent", subagent_type: "luna" },
          },
          {
            type: "tool_execution_end",
            toolCallId: "agent-stop",
            toolName: "Agent",
            result: {
              content: [{ type: "text", text: "Agent started in background." }],
              details: {
                description: "Stoppable agent",
                subagentType: "luna",
                status: "background",
                agentId: "stoppable-agent-id",
              },
            },
            isError: false,
          },
          { type: "agent_settled" },
        ]);
        yield* Fiber.join(settled);
        const completed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "task.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        h.client.promptEntered = yield* Deferred.make<void>();
        const stopping = yield* adapter
          .interruptTurn(ThreadId.make("thread"))
          .pipe(Effect.forkChild);
        yield* Deferred.await(h.client.promptEntered);
        const command = h.client.calls.prompts.at(-1)?.message ?? "";
        assert.match(command, /^\/t3code-control /u);
        const request = decodeBridgeControlCommand(
          Buffer.from(command.slice(command.indexOf(" ") + 1), "base64url").toString("utf8"),
        );
        assert.equal(request.agentId, "stoppable-agent-id");
        yield* Queue.offer(h.client.input, {
          type: "extension_ui_request",
          id: "bridge-stop-result",
          method: "notify",
          message: bridgeMessage({
            version: 1,
            kind: "control.result",
            requestId: request.requestId,
            agentId: request.agentId,
            success: true,
          }),
        });
        yield* Fiber.join(stopping);
        const completedEvent = yield* Fiber.join(completed);
        assert.equal(Option.isSome(completedEvent), true);
        if (Option.isSome(completedEvent)) {
          assert.equal(completedEvent.value.payload.status, "stopped");
          assert.equal(completedEvent.value.payload.summary, "Subagent stop confirmed.");
        }
        assert.equal(h.client.calls.abort, 0);
      }),
    );
  });

  it.effect("reports detached Agent stop as unsupported without the bridge", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const settled = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "launch unsupported agent",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "agent-unsupported",
            toolName: "Agent",
            args: { description: "Unsupported agent", subagent_type: "luna" },
          },
          {
            type: "tool_execution_end",
            toolCallId: "agent-unsupported",
            toolName: "Agent",
            result: {
              content: [{ type: "text", text: "Agent started in background." }],
              details: {
                description: "Unsupported agent",
                subagentType: "luna",
                status: "background",
                agentId: "unsupported-agent-id",
              },
            },
            isError: false,
          },
          { type: "agent_settled" },
        ]);
        yield* Fiber.join(settled);
        const result = yield* adapter.interruptTurn(ThreadId.make("thread")).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(h.client.calls.abort, 0);
        assert.equal(h.client.calls.prompt, 1);
      }),
    );
  });

  it.effect("settles async Agent tasks when get_subagent_result consumes the notification", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        let completedTurns = 0;
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => {
            if (event.type !== "turn.completed") return false;
            completedTurns += 1;
            return completedTurns === 2;
          }),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "launch one background agent",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "agent-consumed",
            toolName: "Agent",
            args: {
              description: "Consumed result",
              subagent_type: "luna",
              run_in_background: true,
            },
          },
          {
            type: "tool_execution_end",
            toolCallId: "agent-consumed",
            toolName: "Agent",
            result: {
              content: [{ type: "text", text: "Agent started in background." }],
              details: {
                description: "Consumed result",
                subagentType: "luna",
                status: "background",
                agentId: "async-consumed",
              },
            },
            isError: false,
          },
          { type: "agent_settled" },
          { type: "agent_start" },
          {
            type: "tool_execution_start",
            toolCallId: "get-consumed",
            toolName: "get_subagent_result",
            args: { agent_id: "async-consumed", wait: true },
          },
          {
            type: "tool_execution_end",
            toolCallId: "get-consumed",
            toolName: "get_subagent_result",
            result: {
              content: [
                {
                  type: "text",
                  text: "Agent: async-consumed\nType: luna | Status: completed | Tool uses: 2 | 4.3k token\n\nConsumed result OK",
                },
              ],
            },
            isError: false,
          },
          { type: "agent_settled" },
        ]);

        const events = Array.from(yield* Fiber.join(collected));
        const tasks = events.filter(
          (
            event,
          ): event is Extract<
            ProviderRuntimeEvent,
            { type: "task.started" | "task.progress" | "task.completed" }
          > =>
            event.type === "task.started" ||
            event.type === "task.progress" ||
            event.type === "task.completed",
        );
        assert.deepEqual(
          tasks.map((event) => event.type),
          ["task.started", "task.progress", "task.completed"],
        );
        assert.equal(new Set(tasks.map((event) => event.payload.taskId)).size, 1);
        const completed = tasks[2] as Extract<ProviderRuntimeEvent, { type: "task.completed" }>;
        assert.equal(completed.payload.status, "completed");
        assert.equal(completed.payload.summary?.includes("Consumed result OK"), true);
        assert.deepEqual(completed.payload.typedUsage, { totalTokens: 4_300, toolUses: 2 });
        assert.equal(events.filter((event) => event.type === "turn.started").length, 2);
      }),
    );
  });

  it.effect("projects workflow agent progress into the Agents panel lifecycle", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const stream = yield* collectThroughSentinel(adapter);
        const turn = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "run workflow",
          modelSelection,
        });
        stream.setSentinel(turn.turnId);
        const runningDetails = {
          runId: "wf-1",
          name: "Audit",
          phases: [{ title: "Scan" }],
          agents: [
            {
              index: 0,
              label: "Security scan",
              phase: "Scan",
              state: "running",
              model: "openai/gpt-5",
              startedAt: 100,
              preview: "Checking auth",
              usage: { input: 10, output: 2, cacheRead: 3 },
            },
          ],
        };
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "workflow-1",
            toolName: "workflow",
            args: { script: "return {}" },
          },
          {
            type: "tool_execution_update",
            toolCallId: "workflow-1",
            toolName: "workflow",
            partialResult: {
              content: [{ type: "text", text: "starting" }],
              details: { ...runningDetails, agents: [] },
            },
          },
          {
            type: "tool_execution_update",
            toolCallId: "workflow-1",
            toolName: "workflow",
            partialResult: {
              content: [{ type: "text", text: "running" }],
              details: runningDetails,
            },
          },
          {
            type: "tool_execution_end",
            toolCallId: "workflow-1",
            toolName: "workflow",
            result: {
              content: [{ type: "text", text: "done" }],
              details: {
                ...runningDetails,
                agents: [
                  {
                    ...runningDetails.agents[0],
                    state: "done",
                    finishedAt: 250,
                    preview: "Auth checked",
                    usage: { input: 20, output: 5, cacheRead: 4 },
                  },
                ],
              },
            },
            isError: false,
          },
          { type: "agent_settled" },
        ]);

        const events = Array.from(yield* Fiber.join(stream.collected));
        const tasks = events.filter(
          (
            event,
          ): event is Extract<
            ProviderRuntimeEvent,
            { type: "task.started" | "task.progress" | "task.completed" }
          > =>
            event.type === "task.started" ||
            event.type === "task.progress" ||
            event.type === "task.completed",
        );
        assert.deepEqual(
          tasks.map((event) => event.type),
          ["task.started", "task.started", "task.progress", "task.completed", "task.completed"],
        );
        const coordinator = tasks.find(
          (event) => event.type === "task.started" && event.payload.taskType === "local_workflow",
        );
        const started = tasks.find(
          (event) => event.type === "task.started" && event.payload.taskType === "workflow-agent",
        );
        const progress = tasks.find((event) => event.type === "task.progress");
        const completed = tasks.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
            event.type === "task.completed" && event.payload.taskType === "workflow-agent",
        );
        assert.equal(coordinator?.payload.title, "Audit");
        assert.equal(started?.payload.parentAgentId, coordinator?.payload.taskId);
        assert.equal(started?.payload.workflowName, "Audit");
        assert.equal(started?.payload.phaseTitle, "Scan");
        assert.equal(progress?.payload.typedUsage?.totalTokens, 12);
        assert.equal(completed?.payload.typedUsage?.durationMs, 150);
        assert.equal(completed?.payload.status, "completed");
      }),
    );
  });

  it.effect("keeps one T3 turn across native cycles and settles only at agent_settled", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 5).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const turn = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } },
          { type: "agent_end" },
          { type: "turn_end" },
          { type: "turn_start" },
          { type: "agent_settled" },
        ]);
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepEqual(
          events.map((event) => event.type),
          ["turn.started", "item.started", "content.delta", "item.completed", "turn.completed"],
        );
        assert.equal(
          events.every((event) => event.turnId === turn.turnId),
          true,
        );
        assert.equal(events[1]?.itemId, events[2]?.itemId);
        assert.equal(events[2]?.itemId, events[3]?.itemId);
        assert.deepEqual(h.client.calls.thinking, ["max"]);
      }),
    );
  });

  it.effect("keeps steered Pi responses as separate assistant messages", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const eventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const first = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "make the change",
          modelSelection,
        });
        const steering = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "do not make more changes",
          modelSelection,
        });
        assert.equal(steering.turnId, first.turnId);
        assert.equal(h.client.calls.prompts[1]?.streamingBehavior, "steer");
        yield* Queue.offerAll(h.client.input, [
          { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done." } },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Done." }],
              stopReason: "stop",
            },
          },
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "Understood." },
          },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Understood." }],
              stopReason: "stop",
            },
          },
          { type: "agent_settled" },
        ]);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.deepEqual(
          events.map((event) => event.type),
          [
            "turn.started",
            "item.started",
            "content.delta",
            "item.completed",
            "thread.token-usage.updated",
            "item.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );
        const assistantStarts = events.filter((event) => event.type === "item.started");
        assert.equal(assistantStarts.length, 2);
        assert.notEqual(assistantStarts[0]?.itemId, assistantStarts[1]?.itemId);
      }),
    );
  });

  it.effect("continues an incomplete turn after automatic threshold compaction", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const eventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const turn = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "research the subject",
          modelSelection,
        });
        h.client.promptEntered = yield* Deferred.make<void>();
        yield* Queue.offerAll(h.client.input, [
          {
            type: "message_end",
            message: { role: "assistant", content: [], stopReason: "toolUse" },
          },
          {
            type: "compaction_end",
            reason: "threshold",
            result: {
              summary: "Work completed so far",
              firstKeptEntryId: "entry-1",
              tokensBefore: 193_444,
              estimatedTokensAfter: 34_000,
            },
            aborted: false,
            willRetry: false,
          },
        ]);
        yield* Deferred.await(h.client.promptEntered);
        assert.equal(h.client.calls.prompt, 2);
        assert.deepEqual(h.client.calls.prompts[1], {
          message: "Continue the current task after automatic context compaction.",
          images: undefined,
          streamingBehavior: "followUp",
        });
        yield* Queue.offerAll(h.client.input, [
          { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              stopReason: "stop",
            },
          },
          { type: "agent_settled" },
        ]);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.deepEqual(
          events.map((event) => event.type),
          [
            "turn.started",
            "thread.token-usage.updated",
            "item.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );
        assert.equal(
          events.every((event) => event.turnId === turn.turnId),
          true,
        );
      }),
    );
  });

  it.effect("does not add a continuation after a complete threshold compaction", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "answer normally",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "finished" }],
              stopReason: "stop",
            },
          },
          {
            type: "compaction_end",
            reason: "threshold",
            result: {
              summary: "Finished work",
              firstKeptEntryId: "entry-1",
              tokensBefore: 193_444,
              estimatedTokensAfter: 34_000,
            },
            aborted: false,
            willRetry: false,
          },
          { type: "agent_settled" },
        ]);
        yield* Fiber.join(eventsFiber);
        assert.equal(h.client.calls.prompt, 1);
      }),
    );
  });

  it.effect("treats failed and aborted Pi assistant messages as non-successful turns", () => {
    const failedHarness = makeHarness();
    return withAdapter(failedHarness, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const failedEventsFiber = yield* Stream.take(adapter.streamEvents, 4).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "fail",
          modelSelection,
        });
        yield* Queue.offer(failedHarness.client.input, {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "authentication failed",
          },
        });
        const failedEvents = Array.from(yield* Fiber.join(failedEventsFiber));
        assert.deepEqual(
          failedEvents.map((event) => event.type),
          ["turn.started", "thread.token-usage.updated", "runtime.error", "turn.completed"],
        );
        const failed = failedEvents[3] as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
        assert.equal(failed.payload.state, "failed");
        assert.equal(failed.payload.errorMessage, "authentication failed");
      }),
    ).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const abortedHarness = makeHarness();
          return withAdapter(abortedHarness, (adapter) =>
            Effect.gen(function* () {
              yield* start(adapter);
              const eventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
                Stream.runCollect,
                Effect.forkChild,
              );
              yield* adapter.sendTurn({
                threadId: ThreadId.make("thread"),
                input: "abort",
                modelSelection,
              });
              yield* Queue.offerAll(abortedHarness.client.input, [
                {
                  type: "message_end",
                  message: { role: "assistant", content: [], stopReason: "aborted" },
                },
                { type: "agent_settled" },
              ]);
              const events = Array.from(yield* Fiber.join(eventsFiber));
              const terminal = events[2] as Extract<
                ProviderRuntimeEvent,
                { type: "turn.completed" }
              >;
              assert.equal(terminal.payload.state, "interrupted");
            }),
          );
        }),
      ),
    );
  });

  it.effect("closes whitespace-only assistant items at settlement", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const eventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "whitespace",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "   " } },
          { type: "agent_settled" },
        ]);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.deepEqual(
          events.map((event) => event.type),
          ["turn.started", "item.started", "content.delta", "item.completed", "turn.completed"],
        );
      }),
    );
  });

  it.effect(
    "suppresses blank assistant items and records interruption before abort settles",
    () => {
      const h = makeHarness();
      h.client.abortBeforeSettle = true;
      return withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const collected = yield* Stream.take(adapter.streamEvents, 2).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );
          const turn = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "hello",
            modelSelection,
          });
          yield* adapter.interruptTurn(ThreadId.make("thread"), turn.turnId);
          const events = Array.from(yield* Fiber.join(collected));
          assert.deepEqual(
            events.map((event) => event.type),
            ["turn.started", "turn.completed"],
          );
          const terminal = events[1] as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
          assert.equal(terminal.payload.state, "interrupted");
        }),
      );
    },
  );

  it.effect("terminalizes an accepted turn before explicit stop closes its session", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const fence = yield* collectThroughSentinel(adapter);
        const accepted = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        yield* adapter.stopSession(ThreadId.make("thread"));
        yield* start(adapter);
        const sentinel = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "sentinel",
          modelSelection,
        });
        fence.setSentinel(sentinel.turnId);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(fence.collected));
        const acceptedEvents = events.filter((event) => event.turnId === accepted.turnId);
        assert.deepEqual(
          acceptedEvents.map((event) => event.type),
          ["turn.started", "turn.completed"],
        );
        const completed = acceptedEvents[1] as Extract<
          ProviderRuntimeEvent,
          { type: "turn.completed" }
        >;
        assert.equal(completed.turnId, accepted.turnId);
        assert.equal(completed.payload.state, "interrupted");
        assert.equal(completed.payload.stopReason, "abort");
      }),
    );
  });

  it.effect("fails only the turn when settlement state lookup fails", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const eventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "first",
          modelSelection,
        });
        h.client.failGetState = true;
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.deepEqual(
          events.map((event) => event.type),
          ["turn.started", "runtime.error", "turn.completed"],
        );
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), true);
        h.client.failGetState = false;
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "retry",
        });
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("stop wins settlement blocked in get_state without duplicate completion", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const session = yield* start(adapter);
        h.client.getStateEntered = yield* Deferred.make<void>();
        h.client.getStateGate = yield* Deferred.make<void>();
        let sentinelTurnId: string | undefined;
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil(
            (event) => event.type === "turn.completed" && event.turnId === sentinelTurnId,
          ),
          Stream.runCollect,
          Effect.forkChild,
        );
        const first = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        yield* Deferred.await(h.client.getStateEntered);
        yield* adapter.stopSession(ThreadId.make("thread"));
        yield* Deferred.succeed(h.client.getStateGate, undefined);
        h.client.getStateEntered = undefined;
        h.client.getStateGate = undefined;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: instanceId,
          threadId: ThreadId.make("thread"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: session.resumeCursor,
        });
        const sentinel = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "sentinel",
          modelSelection,
        });
        sentinelTurnId = sentinel.turnId;
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(collected));
        const completed = events.filter(
          (event) => event.type === "turn.completed" && event.turnId === first.turnId,
        );
        assert.equal(completed.length, 1);
        assert.equal(
          (completed[0] as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>).payload.state,
          "interrupted",
        );
      }),
    );
  });

  it.effect("terminalizes an accepted turn when its blocked prompt fiber is interrupted", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      h.client.promptEntered = yield* Deferred.make<void>();
      h.client.promptGate = yield* Deferred.make<void>();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const fence = yield* collectThroughSentinel(adapter);
          const sending = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              input: "hello",
              modelSelection,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.client.promptEntered!);
          yield* Fiber.interrupt(sending);
          h.client.promptGate = undefined;
          yield* start(adapter);
          const sentinel = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "sentinel",
            modelSelection,
          });
          fence.setSentinel(sentinel.turnId);
          yield* Queue.offer(h.client.input, { type: "agent_settled" });
          const events = Array.from(yield* Fiber.join(fence.collected));
          const interruptedTurnId = events[0]?.turnId;
          const interruptedEvents = events.filter((event) => event.turnId === interruptedTurnId);
          assert.deepEqual(
            interruptedEvents.map((event) => event.type),
            ["turn.started", "turn.completed"],
          );
          assert.equal(
            (interruptedEvents[1] as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>)
              .payload.state,
            "interrupted",
          );
        }),
      );
    }),
  );

  it.effect("fails an accepted turn when the transport event stream shuts down", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const fence = yield* collectThroughSentinel(adapter);
        const accepted = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        yield* Queue.shutdown(h.client.input);
        while (yield* adapter.hasSession(ThreadId.make("thread"))) yield* Effect.yieldNow;
        h.client.input = yield* Queue.unbounded<PiRpcEvent>();
        h.client.events = Stream.fromQueue(h.client.input);
        yield* start(adapter);
        const sentinel = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "sentinel",
          modelSelection,
        });
        fence.setSentinel(sentinel.turnId);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(fence.collected));
        const acceptedEvents = events.filter((event) => event.turnId === accepted.turnId);
        assert.deepEqual(
          acceptedEvents.map((event) => event.type),
          ["turn.started", "runtime.error", "turn.completed"],
        );
        const completed = acceptedEvents.filter((event) => event.type === "turn.completed");
        assert.equal(completed.length, 1);
        assert.equal(completed[0]?.turnId, accepted.turnId);
        assert.equal(completed[0]?.payload.state, "failed");
      }),
    );
  });

  it.effect("rejects startup when the transport event stream is already closed", () => {
    const h = makeHarness();
    h.client.events = Stream.empty;
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const result = yield* start(adapter).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
        assert.equal(h.client.calls.close, 1);
        const files = fs
          .readdirSync(h.stateDir, { recursive: true })
          .filter((entry) => String(entry).endsWith(".jsonl"));
        assert.deepEqual(files, []);
      }),
    );
  });

  it.effect("rejects startup while an ended event stream is blocked closing", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      h.client.events = Stream.empty;
      h.client.closeEntered = yield* Deferred.make<void>();
      h.client.closeGate = yield* Deferred.make<void>();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          const startupCompleted = yield* Deferred.make<void>();
          const starting = yield* start(adapter).pipe(
            Effect.result,
            Effect.ensuring(Deferred.succeed(startupCompleted, undefined)),
            Effect.forkChild,
          );
          yield* Deferred.await(h.client.closeEntered!);
          yield* Effect.yieldNow;
          assert.equal(Option.isNone(yield* Deferred.poll(startupCompleted)), true);
          yield* Deferred.succeed(h.client.closeGate!, undefined);
          const result = yield* Fiber.join(starting);
          assert.equal(result._tag, "Failure");
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
        }),
      );
    }),
  );

  it.effect("rejects a send whose preflight races the event stream closing", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      h.client.getAvailableModelsEntered = yield* Deferred.make<void>();
      h.client.getAvailableModelsGate = yield* Deferred.make<void>();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const observed: ProviderRuntimeEvent[] = [];
          const events = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                observed.push(event);
              }),
            ),
            Effect.forkChild,
          );
          const sending = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              input: "hello",
              modelSelection,
            })
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(h.client.getAvailableModelsEntered!);
          yield* Queue.shutdown(h.client.input);
          while (yield* adapter.hasSession(ThreadId.make("thread"))) yield* Effect.yieldNow;
          yield* Deferred.succeed(h.client.getAvailableModelsGate!, undefined);
          const result = yield* Fiber.join(sending);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
          assert.equal(h.client.calls.prompt, 0);
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(events);
          assert.equal(
            observed.some((event) => event.type === "turn.started"),
            false,
          );
        }),
      );
    }),
  );

  it.effect("refreshes current context usage at assistant response boundaries", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const usageSeen =
          yield* Deferred.make<
            Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>
          >();
        let turnId: string | undefined;
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.tap((event) =>
            event.type === "thread.token-usage.updated"
              ? Deferred.succeed(usageSeen, event)
              : Effect.void,
          ),
          Stream.takeUntil((event) => event.type === "turn.completed" && event.turnId === turnId),
          Stream.runCollect,
          Effect.forkChild,
        );
        const sent = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        turnId = sent.turnId;
        yield* Queue.offer(h.client.input, {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Working on it." }],
            stopReason: "toolUse",
          },
        });

        const usage = yield* Deferred.await(usageSeen);
        assert.equal(usage.turnId, sent.turnId);
        assert.deepEqual(usage.payload.usage, {
          usedTokens: 80,
          totalProcessedTokens: 160,
          maxTokens: 200_000,
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 20,
          compactsAutomatically: true,
        });
        assert.equal(h.client.calls.sessionStats, 1);
        assert.equal((yield* adapter.listSessions())[0]?.status, "running");

        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(
          events.filter((event) => event.type === "thread.token-usage.updated").length,
          1,
        );
        assert.equal(events.at(-1)?.type, "turn.completed");
        assert.equal(h.client.calls.sessionStats, 2);
      }),
    );
  });

  it.effect("serializes concurrent sends into one turn with a steering message", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        let sentinelTurnId: string | undefined;
        const firstTerminalSeen = yield* Deferred.make<void>();
        const collected = yield* adapter.streamEvents.pipe(
          Stream.tap((event) =>
            event.type === "turn.completed"
              ? Deferred.succeed(firstTerminalSeen, undefined)
              : Effect.void,
          ),
          Stream.takeUntil(
            (event) => event.type === "turn.completed" && event.turnId === sentinelTurnId,
          ),
          Stream.runCollect,
          Effect.forkChild,
        );
        const send = (input: string) =>
          adapter
            .sendTurn({ threadId: ThreadId.make("thread"), input, modelSelection })
            .pipe(Effect.result);
        const results = yield* Effect.all([send("one"), send("two")], {
          concurrency: "unbounded",
        });
        assert.equal(results.filter((result) => result._tag === "Success").length, 2);
        assert.equal(
          new Set(
            results.flatMap((result) =>
              result._tag === "Success" ? [String(result.success.turnId)] : [],
            ),
          ).size,
          1,
        );
        assert.equal(h.client.calls.prompt, 2);
        assert.deepEqual(
          h.client.calls.prompts.map(({ streamingBehavior }) => streamingBehavior),
          [undefined, "steer"],
        );
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        yield* Deferred.await(firstTerminalSeen);
        const sentinel = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "sentinel",
          modelSelection,
        });
        sentinelTurnId = sentinel.turnId;
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(collected));
        const firstTurnId = results.find((result) => result._tag === "Success")!.success.turnId;
        const firstEvents = events.filter((event) => event.turnId === firstTurnId);
        assert.deepEqual(
          firstEvents.map((event) => event.type),
          ["turn.started", "turn.completed", "thread.token-usage.updated"],
        );
        const usage = firstEvents[2] as Extract<
          ProviderRuntimeEvent,
          { type: "thread.token-usage.updated" }
        >;
        assert.deepEqual(usage.payload.usage, {
          usedTokens: 80,
          totalProcessedTokens: 160,
          maxTokens: 200_000,
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 20,
          compactsAutomatically: true,
        });
      }),
    );
  });

  it.effect("rejects model changes in steering messages", () => {
    const h = makeHarness();
    const changedSelection = createModelSelection(instanceId, "openai/gpt-5.1", [
      { id: "thinkingLevel", value: "high" },
    ]);
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "first",
          modelSelection,
        });
        const steered = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "steer",
            modelSelection: changedSelection,
          })
          .pipe(Effect.result);
        assert.equal(steered._tag, "Failure");
        if (steered._tag === "Failure")
          assert.equal(steered.failure._tag, "ProviderAdapterValidationError");
        assert.equal(h.client.calls.prompt, 1);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("preserves the thinking level when Pi starts a native retry cycle", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const recoveredTurnFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "turn.started" }> =>
              event.type === "turn.started",
          ),
          Stream.drop(1),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "first",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "Stream ended without finish_reason",
            },
          },
          { type: "agent_start" },
        ]);

        const recoveredTurn = yield* Fiber.join(recoveredTurnFiber);
        assert.equal(Option.isSome(recoveredTurn), true);
        if (Option.isNone(recoveredTurn)) return;
        assert.equal(recoveredTurn.value.payload.model, modelSelection.model);
        assert.equal(recoveredTurn.value.payload.effort, "max");

        const steered = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "steer after retry",
          modelSelection,
        });
        assert.equal(steered.turnId, recoveredTurn.value.turnId);
        assert.equal(h.client.calls.prompts[1]?.streamingBehavior, "steer");
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("rolls back a model switch when the thinking-level update fails", () => {
    const h = makeHarness();
    const changedSelection = createModelSelection(instanceId, "openai/gpt-5.1", [
      { id: "thinkingLevel", value: "high" },
    ]);
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "first",
          modelSelection,
        });
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        while ((yield* adapter.listSessions())[0]?.status === "running") yield* Effect.yieldNow;

        h.client.failThinking = true;
        const switched = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "second",
            modelSelection: changedSelection,
          })
          .pipe(Effect.result);
        assert.equal(switched._tag, "Failure");
        assert.equal((yield* adapter.listSessions())[0]?.model, "openai/gpt-5");
        assert.deepEqual(h.client.calls.models.slice(-2), [
          { provider: "openai", id: "gpt-5.1" },
          { provider: "openai", id: "gpt-5" },
        ]);
      }),
    );
  });

  it.effect("uses and updates the active session model when follow-up turns omit selection", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const first = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "first",
          modelSelection,
        });
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        while ((yield* adapter.listSessions())[0]?.status === "running") yield* Effect.yieldNow;
        assert.equal((yield* adapter.listSessions())[0]?.model, "openai/gpt-5");

        const second = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "second",
        });
        assert.notEqual(second.turnId, first.turnId);
        assert.deepEqual(h.client.calls.models, [
          { provider: "openai", id: "gpt-5" },
          { provider: "openai", id: "gpt-5" },
        ]);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("defers settlement until a steering prompt is accepted", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      h.client.promptEntered = yield* Deferred.make<void>();
      h.client.promptGate = yield* Deferred.make<void>();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          yield* Deferred.succeed(h.client.promptGate!, undefined);
          const first = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "first",
            modelSelection,
          });

          h.client.promptEntered = yield* Deferred.make<void>();
          h.client.promptGate = yield* Deferred.make<void>();
          const steering = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              input: "steer",
              modelSelection,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.client.promptEntered!);
          yield* Queue.offer(h.client.input, { type: "agent_settled" });
          yield* Effect.yieldNow;
          assert.equal((yield* adapter.listSessions())[0]?.status, "running");
          yield* Deferred.succeed(h.client.promptGate!, undefined);

          const steered = yield* Fiber.join(steering);
          assert.equal(steered.turnId, first.turnId);
          while ((yield* adapter.listSessions())[0]?.status === "running") yield* Effect.yieldNow;
          assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
        }),
      );
    }),
  );

  it.effect("rechecks a settlement snapshot when steering starts during get_state", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const first = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "first",
            modelSelection,
          });
          h.client.getStateEntered = yield* Deferred.make<void>();
          h.client.getStateGate = yield* Deferred.make<void>();
          h.client.getStateResults.push(
            { ...h.client.state, isStreaming: false },
            { ...h.client.state, isStreaming: true },
          );

          yield* Queue.offer(h.client.input, { type: "agent_settled" });
          yield* Deferred.await(h.client.getStateEntered!);
          const steered = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "steer",
            modelSelection,
          });
          yield* Deferred.succeed(h.client.getStateGate!, undefined);
          while (h.client.getStateResults.length > 0) yield* Effect.yieldNow;

          assert.equal(steered.turnId, first.turnId);
          const running = (yield* adapter.listSessions())[0];
          assert.equal(running?.status, "running");
          assert.equal(running?.activeTurnId, first.turnId);

          h.client.getStateEntered = undefined;
          h.client.getStateGate = undefined;
          h.client.state.isStreaming = false;
          yield* Queue.offer(h.client.input, { type: "agent_settled" });
        }),
      );
    }),
  );

  it.effect("does not let a blocked steering prompt prevent interruption", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const first = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "first",
            modelSelection,
          });

          h.client.promptEntered = yield* Deferred.make<void>();
          h.client.promptGate = yield* Deferred.make<void>();
          const steering = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              input: "steer",
              modelSelection,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.client.promptEntered!);

          yield* adapter.interruptTurn(ThreadId.make("thread"), first.turnId);
          assert.equal(h.client.calls.abort, 1);
          const interruptingSteer = yield* Fiber.interrupt(steering).pipe(Effect.forkChild);
          yield* Deferred.succeed(h.client.promptGate!, undefined);
          yield* Fiber.join(interruptingSteer);
          const running = (yield* adapter.listSessions())[0];
          assert.equal(running?.status, "running");
          assert.equal(running?.activeTurnId, first.turnId);
          assert.equal(h.client.calls.close, 0);
          assert.equal(h.client.calls.abort, 2);

          yield* Queue.offer(h.client.input, { type: "agent_settled" });
        }),
      );
    }),
  );

  it.effect("leaves the active turn running when a steering prompt fails", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const first = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "first",
          modelSelection,
        });
        h.client.failPrompt = true;

        const failed = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "steer",
            modelSelection,
          })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        const running = (yield* adapter.listSessions())[0];
        assert.equal(running?.status, "running");
        assert.equal(running?.activeTurnId, first.turnId);

        h.client.failPrompt = false;
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("resumes only an exact persisted cursor", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const first = yield* start(adapter);
        yield* adapter.stopSession(ThreadId.make("thread"));
        const resumed = yield* adapter.startSession({
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: instanceId,
          threadId: ThreadId.make("thread"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: first.resumeCursor,
        });
        assert.deepEqual(resumed.resumeCursor, first.resumeCursor);
        assert.equal(h.spawns.length, 2);
        yield* adapter.stopSession(ThreadId.make("thread"));

        const invalid = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("thread"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: {
              ...(first.resumeCursor as Record<string, unknown>),
              sessionId: "wrong-session",
            },
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
        assert.equal(h.spawns.length, 2);
      }),
    );
  });

  it.effect("removes a fresh placeholder after startup fails", () => {
    const h = makeHarness({ failStart: true });
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        assert.equal((yield* start(adapter).pipe(Effect.result))._tag, "Failure");
        const files = fs
          .readdirSync(h.stateDir, { recursive: true })
          .filter((entry) => String(entry).endsWith(".jsonl"));
        assert.deepEqual(files, []);
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
      }),
    );
  });

  it.effect("serializes concurrent starts for one thread", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          [start(adapter).pipe(Effect.result), start(adapter).pipe(Effect.result)],
          { concurrency: "unbounded" },
        );
        assert.equal(results.filter((result) => result._tag === "Success").length, 1);
        assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
        assert.equal(h.spawns.length, 1);
      }),
    );
  });

  it.effect("cleans an interrupted startup before publishing ownership", () =>
    Effect.gen(function* () {
      const spawnEntered = yield* Deferred.make<void>();
      const h = makeHarness();
      const interruptedHarness: Harness = {
        ...h,
        makeClient: () =>
          Deferred.succeed(spawnEntered, undefined).pipe(Effect.andThen(Effect.never)),
      };
      yield* withAdapter(interruptedHarness, (adapter) =>
        Effect.gen(function* () {
          const starting = yield* Effect.forkChild(start(adapter));
          yield* Deferred.await(spawnEntered);
          yield* Fiber.interrupt(starting);
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
          const files = fs
            .readdirSync(h.stateDir, { recursive: true })
            .filter((entry) => String(entry).endsWith(".jsonl"));
          assert.deepEqual(files, []);
        }),
      );
    }),
  );

  it.effect("releases published startup ownership when interrupted before transfer", () =>
    Effect.gen(function* () {
      const published = yield* Deferred.make<void>();
      const releasePublication = yield* Deferred.make<void>();
      const h = makeHarness();
      let blockPublication = false;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makePiAdapter({
            binaryPath: "pi",
            providerInstanceId: instanceId,
            stateDir: h.stateDir,
            attachmentsDir: h.attachmentsDir,
            makeRpcClient: h.makeClient,
            onSessionPublished: () =>
              blockPublication
                ? Deferred.succeed(published, undefined).pipe(
                    Effect.andThen(Deferred.await(releasePublication)),
                  )
                : Effect.void,
          });
          const durable = yield* start(adapter, "durable");
          yield* adapter.stopSession(ThreadId.make("durable"));
          blockPublication = true;
          const starting = yield* Effect.forkChild(
            adapter.startSession({
              provider: ProviderDriverKind.make("pi"),
              providerInstanceId: instanceId,
              threadId: ThreadId.make("thread"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
              resumeCursor: durable.resumeCursor,
            }),
          );
          yield* Deferred.await(published);
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), true);
          yield* Fiber.interrupt(starting);
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);

          blockPublication = false;
          const reacquired = yield* adapter.startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("replacement"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: durable.resumeCursor,
          });
          assert.equal(reacquired.threadId, ThreadId.make("replacement"));
        }),
      ).pipe(Effect.provide(NodeServices.layer));
    }),
  );

  it.effect("leases a durable session file to one live thread", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const first = yield* start(adapter, "thread-one");
        const second = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("thread-two"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: first.resumeCursor,
          })
          .pipe(Effect.result);
        assert.equal(second._tag, "Failure");
        assert.equal(h.spawns.length, 1);
      }),
    );
  });

  it.effect("fails a rejected prompt and allows the next turn", () => {
    const h = makeHarness();
    h.client.failPrompt = true;
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const failed = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "first",
            modelSelection,
          })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        assert.deepEqual(
          Array.from(yield* Fiber.join(collected)).map((event) => event.type),
          ["turn.started", "runtime.error", "turn.completed"],
        );

        h.client.failPrompt = false;
        const next = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "second",
          modelSelection,
        });
        assert.equal(next.threadId, ThreadId.make("thread"));
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("closes the session after an ambiguous prompt transport failure", () => {
    const h = makeHarness();
    h.client.fatalPrompt = true;
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const failed = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "ambiguous",
            modelSelection,
          })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        if (failed._tag === "Failure")
          assert.strictEqual(failed.failure.cause, h.client.fatalPromptError);
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
        assert.equal(h.client.calls.close, 1);
      }),
    );
  });

  it.effect("fails identity drift, closes once, and makes stop idempotent", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        h.client.state = { ...h.client.state, sessionId: "drift" };
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepEqual(
          events.map((event) => event.type),
          ["turn.started", "runtime.error", "turn.completed"],
        );
        yield* adapter.stopSession(ThreadId.make("thread"));
        yield* adapter.stopSession(ThreadId.make("thread"));
        assert.equal(h.client.calls.close, 1);
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
      }),
    );
  });

  it.effect("emits exactly one graceful session.exited on explicit stop", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "session.exited"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const accepted = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        yield* adapter.stopSession(ThreadId.make("thread"));
        const events = Array.from(yield* Fiber.join(collected));
        const exits = events.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "session.exited" }> =>
            event.type === "session.exited",
        );
        assert.equal(exits.length, 1);
        assert.equal(events.at(-1)?.type, "session.exited");
        assert.equal(exits[0]?.payload.exitKind, "graceful");
        assert.equal(exits[0]?.payload.reason, "Session stopped.");
        assert.equal(exits[0]?.payload.recoverable, false);
        assert.equal(exits[0]?.turnId, undefined);
        const turnEvents = events.filter((event) => event.turnId === accepted.turnId);
        assert.deepEqual(
          turnEvents.map((event) => event.type),
          ["turn.started", "turn.completed"],
        );
        assert.equal(
          (turnEvents[1] as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>).payload
            .state,
          "interrupted",
        );
        assert.equal(events.indexOf(turnEvents[1]!) < events.indexOf(exits[0]!), true);
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
        assert.equal(h.client.calls.close, 1);
      }),
    );
  });

  it.effect(
    "emits one error session.exited when the idle stream dies with background agents",
    () => {
      const h = makeHarness();
      return withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const parentSettled = yield* Deferred.make<void>();
          const collected = yield* adapter.streamEvents.pipe(
            Stream.tap((event) =>
              event.type === "turn.completed"
                ? Deferred.succeed(parentSettled, undefined)
                : Effect.void,
            ),
            Stream.takeUntil((event) => event.type === "session.exited"),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "delegate this",
            modelSelection,
          });
          yield* Queue.offerAll(h.client.input, [
            {
              type: "tool_execution_start",
              toolCallId: "bg-1",
              toolName: "subagent_spawn",
              args: { name: "Background review", harness: "pi" },
            },
            {
              type: "tool_execution_end",
              toolCallId: "bg-1",
              toolName: "subagent_spawn",
              result: {
                content: [{ type: "text", text: "Spawned bg-1" }],
                details: { id: "bg-1", title: "Background review", harness: "pi" },
              },
              isError: false,
            },
            { type: "agent_settled" },
          ]);
          yield* Deferred.await(parentSettled);
          yield* Queue.shutdown(h.client.input);
          const events = Array.from(yield* Fiber.join(collected));
          const exits = events.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "session.exited" }> =>
              event.type === "session.exited",
          );
          const taskCompletions = events.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
              event.type === "task.completed",
          );
          assert.equal(exits.length, 1);
          assert.equal(events.at(-1)?.type, "session.exited");
          assert.equal(exits[0]?.payload.exitKind, "error");
          assert.equal(exits[0]?.payload.reason, "Pi session exited unexpectedly.");
          assert.equal(taskCompletions.length, 1);
          assert.equal(taskCompletions[0]?.payload.status, "failed");
          assert.equal(String(taskCompletions[0]?.payload.taskId), "pi-subagent:bg-1");
          assert.equal(events.indexOf(taskCompletions[0]!) < events.indexOf(exits[0]!), true);
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
          assert.equal(h.client.calls.close, 1);
        }),
      );
    },
  );

  it.effect(
    "fails the active turn and emits an error session.exited when the stream dies mid-turn",
    () => {
      const h = makeHarness();
      return withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const collected = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "session.exited"),
            Stream.runCollect,
            Effect.forkChild,
          );
          const accepted = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "hello",
            modelSelection,
          });
          yield* Queue.shutdown(h.client.input);
          const events = Array.from(yield* Fiber.join(collected));
          const exits = events.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "session.exited" }> =>
              event.type === "session.exited",
          );
          assert.equal(exits.length, 1);
          assert.equal(events.at(-1)?.type, "session.exited");
          assert.equal(exits[0]?.payload.exitKind, "error");
          const turnEvents = events.filter((event) => event.turnId === accepted.turnId);
          assert.deepEqual(
            turnEvents.map((event) => event.type),
            ["turn.started", "runtime.error", "turn.completed"],
          );
          assert.equal(
            (turnEvents.at(-1) as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>).payload
              .state,
            "failed",
          );
          assert.equal(events.indexOf(turnEvents.at(-1)!) < events.indexOf(exits[0]!), true);
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
          assert.equal(h.client.calls.close, 1);
        }),
      );
    },
  );

  it.effect(
    "terminalizes background agent, workflow, and extension tasks before session.exited",
    () => {
      const h = makeHarness();
      return withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const parentSettled = yield* Deferred.make<void>();
          const collected = yield* adapter.streamEvents.pipe(
            Stream.tap((event) =>
              event.type === "turn.completed"
                ? Deferred.succeed(parentSettled, undefined)
                : Effect.void,
            ),
            Stream.takeUntil((event) => event.type === "session.exited"),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "delegate everything",
            modelSelection,
          });
          yield* Queue.offerAll(h.client.input, [
            {
              type: "tool_execution_start",
              toolCallId: "agent-bg",
              toolName: "Agent",
              args: {
                description: "Background hello",
                subagent_type: "luna",
                run_in_background: true,
                prompt: "Reply later",
              },
            },
            {
              type: "tool_execution_end",
              toolCallId: "agent-bg",
              toolName: "Agent",
              result: {
                content: [{ type: "text", text: "Agent started in background." }],
                details: {
                  displayName: "luna",
                  description: "Background hello",
                  subagentType: "luna",
                  status: "background",
                  agentId: "agent-bg-id",
                },
              },
              isError: false,
            },
            {
              type: "tool_execution_start",
              toolCallId: "wf-1",
              toolName: "workflow",
              args: { script: "return {}" },
            },
            {
              type: "tool_execution_update",
              toolCallId: "wf-1",
              toolName: "workflow",
              partialResult: {
                content: [{ type: "text", text: "running" }],
                details: {
                  runId: "run-1",
                  name: "Audit",
                  phases: [{ title: "Scan" }],
                  agents: [{ index: 0, label: "Scanner", state: "running" }],
                },
              },
            },
            {
              type: "tool_execution_start",
              toolCallId: "subagent-1",
              toolName: "subagent",
              args: { tasks: [{ agent: "scout", task: "Find the auth flow" }] },
            },
            {
              type: "tool_execution_update",
              toolCallId: "subagent-1",
              toolName: "subagent",
              partialResult: {
                content: [{ type: "text", text: "running" }],
                details: {
                  mode: "parallel",
                  agentScope: "user",
                  projectAgentsDir: null,
                  results: [
                    {
                      agent: "scout",
                      agentSource: "user",
                      task: "Find the auth flow",
                      exitCode: -1,
                      messages: [],
                      stderr: "",
                      model: "openai/gpt-5",
                      usage: {
                        input: 30,
                        output: 4,
                        cacheRead: 20,
                        cacheWrite: 0,
                        cost: 0,
                        contextTokens: 34,
                        turns: 1,
                      },
                    },
                  ],
                },
              },
            },
            { type: "agent_settled" },
          ]);
          yield* Deferred.await(parentSettled);
          yield* Queue.shutdown(h.client.input);
          const events = Array.from(yield* Fiber.join(collected));
          const exits = events.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "session.exited" }> =>
              event.type === "session.exited",
          );
          const taskCompletions = events.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
              event.type === "task.completed",
          );
          // One async Agent task, one workflow coordinator, one workflow agent,
          // and one reference-extension subagent task.
          assert.equal(taskCompletions.length, 4);
          assert.equal(exits.length, 1);
          assert.equal(events.at(-1)?.type, "session.exited");
          const lastTaskIndex = Math.max(...taskCompletions.map((event) => events.indexOf(event)));
          assert.equal(lastTaskIndex < events.indexOf(exits[0]!), true);
          for (const completed of taskCompletions) assert.equal(completed.payload.status, "failed");
          assert.deepEqual(taskCompletions.map((event) => String(event.payload.taskId)).sort(), [
            "pi-subagent:agent-bg",
            "pi-subagent:subagent-1:0",
            "pi-workflow:run-1:0",
            "pi-workflow:run-1:coordinator",
          ]);
        }),
      );
    },
  );

  it.effect("does not duplicate task completion when map keys alias the same agent", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const parentSettled = yield* Deferred.make<void>();
        const collected = yield* adapter.streamEvents.pipe(
          Stream.tap((event) =>
            event.type === "turn.completed"
              ? Deferred.succeed(parentSettled, undefined)
              : Effect.void,
          ),
          Stream.takeUntil((event) => event.type === "session.exited"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "delegate twice",
          modelSelection,
        });
        // Two distinct tool calls report the same extension agent id. The
        // by-id map keeps only the newest task; the older task survives only
        // in the tool-call map. Identity-based close collection must still
        // terminalize each unique task exactly once.
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "call-a",
            toolName: "subagent_spawn",
            args: { name: "Review A", harness: "pi" },
          },
          {
            type: "tool_execution_end",
            toolCallId: "call-a",
            toolName: "subagent_spawn",
            result: {
              content: [{ type: "text", text: "Spawned A" }],
              details: { id: "shared-id", title: "Review A", harness: "pi" },
            },
            isError: false,
          },
          {
            type: "tool_execution_start",
            toolCallId: "call-b",
            toolName: "subagent_spawn",
            args: { name: "Review B", harness: "pi" },
          },
          {
            type: "tool_execution_end",
            toolCallId: "call-b",
            toolName: "subagent_spawn",
            result: {
              content: [{ type: "text", text: "Spawned B" }],
              details: { id: "shared-id", title: "Review B", harness: "pi" },
            },
            isError: false,
          },
          { type: "agent_settled" },
        ]);
        yield* Deferred.await(parentSettled);
        yield* Queue.shutdown(h.client.input);
        const events = Array.from(yield* Fiber.join(collected));
        const taskCompletions = events.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
            event.type === "task.completed",
        );
        assert.equal(taskCompletions.length, 2);
        assert.equal(new Set(taskCompletions.map((event) => String(event.payload.taskId))).size, 2);
        assert.deepEqual(taskCompletions.map((event) => String(event.payload.taskId)).sort(), [
          "pi-subagent:call-a",
          "pi-subagent:call-b",
        ]);
        assert.equal(events.filter((event) => event.type === "session.exited").length, 1);
      }),
    );
  });

  it.effect("does not duplicate session.exited when stop is repeated", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "session.exited"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.stopSession(ThreadId.make("thread"));
        yield* adapter.stopSession(ThreadId.make("thread"));
        yield* adapter.stopSession(ThreadId.make("thread"));
        const events = Array.from(yield* Fiber.join(collected));
        assert.equal(events.filter((event) => event.type === "session.exited").length, 1);
        assert.equal(events.at(-1)?.type, "session.exited");
        assert.equal(h.client.calls.close, 1);
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
      }),
    );
  });

  it.effect(
    "replaces an idle same-thread session with the exact resume cursor without session.exited",
    () => {
      const h = makeHarness();
      return withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          const first = yield* start(adapter);
          const cursor = first.resumeCursor;
          const cwd = first.cwd;
          const exited = yield* Deferred.make<void>();
          yield* adapter.streamEvents.pipe(
            Stream.tap((event) =>
              event.type === "session.exited" ? Deferred.succeed(exited, undefined) : Effect.void,
            ),
            Stream.runDrain,
            Effect.forkChild,
          );
          const second = yield* adapter.startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("thread"),
            cwd,
            runtimeMode: "full-access",
            resumeCursor: cursor,
          });
          assert.equal(second.threadId, first.threadId);
          assert.deepEqual(second.resumeCursor, cursor);
          assert.equal(h.spawns.length, 2);
          assert.equal(h.client.calls.close, 1);
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), true);
          // An in-place replacement must not emit session.exited.
          assert.equal(yield* Deferred.poll(exited).pipe(Effect.map(Option.isSome)), false);
          // The replacement session is live and still emits the exit on stop.
          yield* adapter.stopSession(ThreadId.make("thread"));
          yield* Deferred.await(exited).pipe(Effect.timeout("1 second"), Effect.orDie);
          assert.equal(h.client.calls.close, 2);
        }),
      );
    },
  );

  it.effect("rejects same-thread replacement while the old session has active work", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const first = yield* start(adapter);
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "busy",
          modelSelection,
        });
        const rejected = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("thread"),
            cwd: first.cwd,
            runtimeMode: "full-access",
            resumeCursor: first.resumeCursor,
          })
          .pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
        if (rejected._tag === "Failure")
          assert.equal(rejected.failure._tag, "ProviderAdapterValidationError");
        // The old session is untouched.
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), true);
        assert.equal(h.spawns.length, 1);
        assert.equal(h.client.calls.close, 0);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect(
    "rejects same-thread replacement when the resume cursor targets another session file",
    () => {
      const h = makeHarness();
      return withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          const first = yield* start(adapter);
          const sessionsRoot = path.join(
            h.stateDir,
            "providers",
            "pi",
            encodeURIComponent(String(instanceId)),
            "sessions",
          );
          fs.mkdirSync(sessionsRoot, { recursive: true });
          const otherFile = path.join(sessionsRoot, "other-session.jsonl");
          fs.writeFileSync(
            otherFile,
            `{"type":"session","id":"other-session","cwd":"${first.cwd}"}\n`,
          );
          const rejected = yield* adapter
            .startSession({
              provider: ProviderDriverKind.make("pi"),
              providerInstanceId: instanceId,
              threadId: ThreadId.make("thread"),
              cwd: first.cwd,
              runtimeMode: "full-access",
              resumeCursor: {
                schemaVersion: 1,
                sessionFile: otherFile,
                sessionId: "other-session",
              },
            })
            .pipe(Effect.result);
          assert.equal(rejected._tag, "Failure");
          if (rejected._tag === "Failure")
            assert.equal(rejected.failure._tag, "ProviderAdapterValidationError");
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), true);
          assert.equal(h.spawns.length, 1);
          assert.equal(h.client.calls.close, 0);
        }),
      );
    },
  );

  it.effect("rejects same-thread replacement when the working directory changed", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const first = yield* start(adapter);
        const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pi-adapter-cwd-"));
        const rejected = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("thread"),
            cwd: otherCwd,
            runtimeMode: "full-access",
            resumeCursor: first.resumeCursor,
          })
          .pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
        if (rejected._tag === "Failure")
          assert.equal(rejected.failure._tag, "ProviderAdapterValidationError");
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), true);
        assert.equal(h.spawns.length, 1);
        assert.equal(h.client.calls.close, 0);
      }),
    );
  });

  it.effect("rejects same-thread replacement when no resume cursor is supplied", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const first = yield* start(adapter);
        const rejected = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("thread"),
            cwd: first.cwd,
            runtimeMode: "full-access",
          })
          .pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
        if (rejected._tag === "Failure")
          assert.equal(rejected.failure._tag, "ProviderAdapterValidationError");
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), true);
        assert.equal(h.spawns.length, 1);
      }),
    );
  });

  it.effect(
    "leaks nothing and keeps the durable cursor recoverable when a replacement fails",
    () => {
      const h = makeHarness();
      return withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          const first = yield* start(adapter);
          const cursor = first.resumeCursor;
          h.failNextSpawn = true;
          const failed = yield* adapter
            .startSession({
              provider: ProviderDriverKind.make("pi"),
              providerInstanceId: instanceId,
              threadId: ThreadId.make("thread"),
              cwd: first.cwd,
              runtimeMode: "full-access",
              resumeCursor: cursor,
            })
            .pipe(Effect.result);
          assert.equal(failed._tag, "Failure");
          assert.equal(h.spawns.length, 2);
          // The idle old context was torn down as a replacement and the failed
          // candidate was rolled back: nothing is published and nothing leaks.
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
          assert.equal(h.client.calls.close, 1);
          // The durable session file was not deleted, so the same cursor starts
          // a fresh process again.
          const recovered = yield* adapter.startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("thread"),
            cwd: first.cwd,
            runtimeMode: "full-access",
            resumeCursor: cursor,
          });
          assert.equal(recovered.threadId, first.threadId);
          assert.deepEqual(recovered.resumeCursor, cursor);
        }),
      );
    },
  );

  it.effect("uses Pi's authoritative get_state model for the startup session model", () => {
    const h = makeHarness();
    h.client.state = {
      ...h.client.state,
      model: { provider: "openai", id: "gpt-5.1", name: "GPT 5.1", reasoning: true },
      thinkingLevel: "high",
    };
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const session = yield* start(adapter);
        assert.equal(session.model, "openai/gpt-5.1");
      }),
    );
  });

  it.effect("falls back to the requested model when get_state omits the loaded model", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const session = yield* adapter.startSession({
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: instanceId,
          threadId: ThreadId.make("thread"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection,
        });
        assert.equal(session.model, modelSelection.model);
      }),
    );
  });

  it.effect(
    "does not attach the interrupted turn id to session-wide task completions on close",
    () => {
      const h = makeHarness();
      return withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const taskStarted = yield* Deferred.make<void>();
          const collected = yield* adapter.streamEvents.pipe(
            Stream.tap((event) =>
              event.type === "task.started"
                ? Deferred.succeed(taskStarted, undefined)
                : Effect.void,
            ),
            Stream.takeUntil((event) => event.type === "session.exited"),
            Stream.runCollect,
            Effect.forkChild,
          );
          const accepted = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "delegate",
            modelSelection,
          });
          // Start a background agent while the parent turn is still active so
          // close must terminalize both the turn and the task.
          yield* Queue.offerAll(h.client.input, [
            {
              type: "tool_execution_start",
              toolCallId: "bg-live",
              toolName: "Agent",
              args: {
                description: "Live background",
                subagent_type: "luna",
                run_in_background: true,
                prompt: "Keep running",
              },
            },
            {
              type: "tool_execution_end",
              toolCallId: "bg-live",
              toolName: "Agent",
              result: {
                content: [{ type: "text", text: "Agent started in background." }],
                details: {
                  displayName: "luna",
                  description: "Live background",
                  subagentType: "luna",
                  status: "background",
                  agentId: "bg-live-id",
                },
              },
              isError: false,
            },
          ]);
          yield* Deferred.await(taskStarted);
          yield* adapter.stopSession(ThreadId.make("thread"));
          const events = Array.from(yield* Fiber.join(collected));
          const exits = events.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "session.exited" }> =>
              event.type === "session.exited",
          );
          const taskCompletions = events.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
              event.type === "task.completed",
          );
          assert.equal(exits.length, 1);
          assert.equal(events.at(-1)?.type, "session.exited");
          assert.equal(taskCompletions.length, 1);
          // Session-wide terminalization must not borrow the interrupted turn id.
          assert.equal(taskCompletions[0]?.turnId, undefined);
          const turnEvents = events.filter(
            (event) =>
              event.turnId === accepted.turnId &&
              (event.type === "turn.started" || event.type === "turn.completed"),
          );
          assert.deepEqual(
            turnEvents.map((event) => event.type),
            ["turn.started", "turn.completed"],
          );
          assert.equal(
            events.indexOf(turnEvents.at(-1)!) < events.indexOf(taskCompletions[0]!),
            true,
          );
          assert.equal(events.indexOf(taskCompletions[0]!) < events.indexOf(exits[0]!), true);
        }),
      );
    },
  );

  it.effect(
    "drains buffered terminal events to a delayed streamEvents consumer on adapter scope close",
    () =>
      Effect.gen(function* () {
        const h = makeHarness();
        const scope = yield* Scope.make();
        let scopeClosed = false;
        try {
          const adapter = yield* makePiAdapter({
            binaryPath: "pi",
            providerInstanceId: instanceId,
            stateDir: h.stateDir,
            attachmentsDir: h.attachmentsDir,
            makeRpcClient: h.makeClient,
          }).pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(NodeServices.layer));
          yield* adapter.startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("thread"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          // Keep an active turn so scope close emits turn and session terminal
          // events into the event queue.
          const accepted = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "hello",
            modelSelection,
          });
          // Deliberately delay the consumer: fork it behind a release gate, then
          // close the adapter scope so the terminal events buffer first. The
          // finalizer must end the queue gracefully (Queue.end), so the delayed
          // consumer still receives every buffered terminal event, with
          // session.exited last, and then completes normally instead of being
          // interrupted on an abandoned queue.
          const releaseConsumer = yield* Deferred.make<void>();
          const eventsFiber = yield* Deferred.await(releaseConsumer)
            .pipe(
              Effect.andThen(
                adapter.streamEvents.pipe(
                  Stream.runCollect,
                  Effect.timeout("1 second"),
                  Effect.orDie,
                ),
              ),
            )
            .pipe(Effect.forkChild);
          yield* Scope.close(scope, Exit.void);
          scopeClosed = true;
          yield* Deferred.succeed(releaseConsumer, undefined);
          const exit = yield* Fiber.await(eventsFiber);
          assert.equal(Exit.isSuccess(exit), true);
          const events = Array.from(Exit.isSuccess(exit) ? exit.value : []);
          const exits = events.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "session.exited" }> =>
              event.type === "session.exited",
          );
          assert.equal(exits.length, 1);
          assert.equal(events.at(-1)?.type, "session.exited");
          const turnEvents = events.filter((event) => event.turnId === accepted.turnId);
          assert.deepEqual(
            turnEvents.map((event) => event.type),
            ["turn.started", "turn.completed"],
          );
          assert.equal(events.indexOf(turnEvents.at(-1)!) < events.indexOf(exits[0]!), true);
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
          assert.equal(h.client.calls.close, 1);
        } finally {
          if (!scopeClosed) yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        }
      }),
  );
});
