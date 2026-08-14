import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const PI_BRIDGE_PREFIX = "t3code.pi-bridge.v1:";
export const PI_BRIDGE_VERSION = 1 as const;
export const PI_SUBAGENTS_RPC_VERSION = 2 as const;

const Usage = Schema.Struct({
  totalTokens: Schema.Number,
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  cacheWriteTokens: Schema.optional(Schema.Number),
  toolUses: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
});

const Ready = Schema.Struct({
  version: Schema.Literal(PI_BRIDGE_VERSION),
  kind: Schema.Literal("bridge.ready"),
  subagentsRpcVersion: Schema.optional(Schema.Number),
  targetedStop: Schema.Boolean,
});

const TaskRegistered = Schema.Struct({
  version: Schema.Literal(PI_BRIDGE_VERSION),
  kind: Schema.Literal("task.registered"),
  invocationId: Schema.String,
  agentId: Schema.String,
  title: Schema.String,
  role: Schema.optional(Schema.String),
  status: Schema.Literals(["queued", "running", "background", "completed", "failed", "stopped"]),
});

const TaskRunning = Schema.Struct({
  version: Schema.Literal(PI_BRIDGE_VERSION),
  kind: Schema.Literal("task.running"),
  invocationId: Schema.String,
  agentId: Schema.String,
  title: Schema.String,
  role: Schema.optional(Schema.String),
});

const TaskCompleted = Schema.Struct({
  version: Schema.Literal(PI_BRIDGE_VERSION),
  kind: Schema.Literal("task.completed"),
  invocationId: Schema.String,
  agentId: Schema.String,
  title: Schema.String,
  role: Schema.optional(Schema.String),
  status: Schema.Literals(["completed", "failed", "stopped"]),
  summary: Schema.optional(Schema.String),
  usage: Schema.optional(Usage),
});

const ControlResult = Schema.Struct({
  version: Schema.Literal(PI_BRIDGE_VERSION),
  kind: Schema.Literal("control.result"),
  requestId: Schema.String,
  agentId: Schema.String,
  success: Schema.Boolean,
  error: Schema.optional(Schema.String),
});

export const PiBridgeEnvelope = Schema.Union([
  Ready,
  TaskRegistered,
  TaskRunning,
  TaskCompleted,
  ControlResult,
]);
export type PiBridgeEnvelope = typeof PiBridgeEnvelope.Type;

const JsonEnvelope = Schema.fromJsonString(PiBridgeEnvelope);

export const decodePiBridgeNotification = Effect.fn("PiBridgeProtocol.decode")(function* (
  message: string,
) {
  if (!message.startsWith(PI_BRIDGE_PREFIX)) return undefined;
  return yield* Schema.decodeUnknownEffect(JsonEnvelope)(message.slice(PI_BRIDGE_PREFIX.length));
});

export const encodePiBridgeNotification = Effect.fn("PiBridgeProtocol.encode")(function* (
  envelope: PiBridgeEnvelope,
) {
  return PI_BRIDGE_PREFIX + (yield* Schema.encodeEffect(JsonEnvelope)(envelope));
});

export const T3_PI_BRIDGE_EXTENSION_SOURCE = String.raw`const PREFIX = "t3code.pi-bridge.v1:";
const VERSION = 1;
const SUPPORTED_SUBAGENTS_RPC = 2;

export default function t3codePiBridge(pi) {
  if (process.env.T3CODE_PI_BRIDGE !== "1") return;

  let currentCtx;
  let subagentsRpcVersion;
  let negotiation;
  const invocationByAgent = new Map();
  const pendingByAgent = new Map();
  const unsubscribers = [];
  const rpcTimeoutMs = Math.max(10, Number(process.env.T3CODE_PI_BRIDGE_RPC_TIMEOUT_MS) || 1500);

  const notify = (payload) => {
    if (!currentCtx || currentCtx.mode !== "rpc") return;
    currentCtx.ui.notify(PREFIX + JSON.stringify({ version: VERSION, ...payload }), "info");
  };

  const rpc = (channel, payload, timeoutMs = rpcTimeoutMs) => new Promise((resolve) => {
    const requestId = payload.requestId;
    const replyChannel = channel + ":reply:" + requestId;
    let settled = false;
    const unsubscribe = pi.events.on(replyChannel, (reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(reply);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve({ success: false, error: "Subagent RPC timed out." });
    }, timeoutMs);
    timer.unref?.();
    pi.events.emit(channel, payload);
  });

  const flushPending = (agentId) => {
    const invocation = invocationByAgent.get(agentId);
    const pending = pendingByAgent.get(agentId);
    if (!invocation || !pending) return;
    pendingByAgent.delete(agentId);
    for (const item of pending) emitLifecycle(item.kind, item.data);
  };

  const emitLifecycle = (kind, data) => {
    if (!data || typeof data.id !== "string") return;
    const invocation = invocationByAgent.get(data.id);
    if (!invocation) {
      const pending = pendingByAgent.get(data.id) || [];
      pending.push({ kind, data });
      pendingByAgent.set(data.id, pending);
      return;
    }
    if (kind === "started") {
      notify({
        kind: "task.running",
        invocationId: invocation.invocationId,
        agentId: data.id,
        title: data.description || invocation.title,
        role: data.type || invocation.role,
      });
      return;
    }
    const failed = kind === "failed";
    const rawStatus = typeof data.status === "string" ? data.status : undefined;
    const status = failed
      ? (rawStatus === "stopped" || rawStatus === "aborted" ? "stopped" : "failed")
      : "completed";
    const tokens = data.tokens && typeof data.tokens === "object" ? data.tokens : undefined;
    const usage = tokens || typeof data.toolUses === "number" || typeof data.durationMs === "number"
      ? {
          totalTokens: typeof tokens?.total === "number" ? tokens.total : 0,
          ...(typeof tokens?.input === "number" ? { inputTokens: tokens.input } : {}),
          ...(typeof tokens?.output === "number" ? { outputTokens: tokens.output } : {}),
          ...(typeof data.toolUses === "number" ? { toolUses: data.toolUses } : {}),
          ...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}),
        }
      : undefined;
    notify({
      kind: "task.completed",
      invocationId: invocation.invocationId,
      agentId: data.id,
      title: data.description || invocation.title,
      role: data.type || invocation.role,
      status,
      ...(typeof data.error === "string" ? { summary: data.error } :
          typeof data.result === "string" ? { summary: data.result.slice(0, 2000) } : {}),
      ...(usage ? { usage } : {}),
    });
  };

  const ping = async () => {
    const requestId = crypto.randomUUID();
    const reply = await rpc("subagents:rpc:ping", { requestId }, Math.min(rpcTimeoutMs, 250));
    subagentsRpcVersion = reply?.success && typeof reply.data?.version === "number"
      ? reply.data.version
      : undefined;
    notify({
      kind: "bridge.ready",
      ...(subagentsRpcVersion !== undefined ? { subagentsRpcVersion } : {}),
      targetedStop: subagentsRpcVersion === SUPPORTED_SUBAGENTS_RPC,
    });
    return subagentsRpcVersion === SUPPORTED_SUBAGENTS_RPC;
  };

  const negotiate = () => {
    if (negotiation) return negotiation;
    negotiation = (async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (await ping()) return;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 200);
          timer.unref?.();
        });
      }
    })().finally(() => { negotiation = undefined; });
    return negotiation;
  };

  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    if (ctx.mode === "rpc") void negotiate();
  });

  pi.on("tool_result", (event, ctx) => {
    currentCtx = ctx;
    if (String(event.toolName).toLowerCase() !== "agent") return;
    const details = event.details;
    if (!details || typeof details.agentId !== "string" || typeof event.toolCallId !== "string") return;
    const invocation = {
      invocationId: event.toolCallId,
      title: typeof details.description === "string" ? details.description : "Subagent",
      role: typeof details.subagentType === "string" ? details.subagentType : undefined,
    };
    invocationByAgent.set(details.agentId, invocation);
    notify({
      kind: "task.registered",
      invocationId: invocation.invocationId,
      agentId: details.agentId,
      title: invocation.title,
      ...(invocation.role ? { role: invocation.role } : {}),
      status: typeof details.status === "string" ? details.status : "running",
    });
    flushPending(details.agentId);
  });

  unsubscribers.push(pi.events.on("subagents:ready", () => { void negotiate(); }));
  unsubscribers.push(pi.events.on("subagents:started", (data) => emitLifecycle("started", data)));
  unsubscribers.push(pi.events.on("subagents:completed", (data) => emitLifecycle("completed", data)));
  unsubscribers.push(pi.events.on("subagents:failed", (data) => emitLifecycle("failed", data)));

  pi.registerCommand("t3code-control", {
    description: "T3 Code Pi bridge control command",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      let request;
      try {
        request = JSON.parse(Buffer.from(String(args || ""), "base64url").toString("utf8"));
      } catch {
        return;
      }
      if (!request || request.version !== VERSION || request.operation !== "stop-subagent" ||
          typeof request.requestId !== "string" || typeof request.agentId !== "string") return;
      if (subagentsRpcVersion !== SUPPORTED_SUBAGENTS_RPC) {
        notify({ kind: "control.result", requestId: request.requestId, agentId: request.agentId,
          success: false, error: "Targeted subagent stop is unavailable." });
        return;
      }
      const reply = await rpc("subagents:rpc:stop", {
        requestId: request.requestId,
        agentId: request.agentId,
      });
      notify({
        kind: "control.result",
        requestId: request.requestId,
        agentId: request.agentId,
        success: reply?.success === true,
        ...(reply?.success === true ? {} : { error: reply?.error || "Subagent stop failed." }),
      });
    },
  });

  pi.on("session_shutdown", () => {
    currentCtx = undefined;
    invocationByAgent.clear();
    pendingByAgent.clear();
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  });
}
`;

export const allocateT3PiBridgeExtension = Effect.fn("PiBridgeProtocol.allocateExtension")(
  function* (stateRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(stateRoot, "extensions");
    const extensionPath = path.join(directory, "t3code-pi-bridge.mjs");
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(extensionPath, T3_PI_BRIDGE_EXTENSION_SOURCE, { mode: 0o600 });
    return extensionPath;
  },
);
