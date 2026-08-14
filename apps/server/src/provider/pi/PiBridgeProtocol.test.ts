// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as NodeAssert from "node:assert/strict";

import {
  allocateT3PiBridgeExtension,
  decodePiBridgeNotification,
  encodePiBridgeNotification,
  PI_BRIDGE_PREFIX,
  T3_PI_BRIDGE_EXTENSION_SOURCE,
} from "./PiBridgeProtocol.ts";

const assert: typeof NodeAssert = NodeAssert;
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Handler = (data: any, ctx?: any) => any;

const makeFakePi = () => {
  const eventHandlers = new Map<string, Set<Handler>>();
  const hooks = new Map<string, Set<Handler>>();
  const commands = new Map<string, { handler: Handler }>();
  const notifications: string[] = [];
  const on = (map: Map<string, Set<Handler>>, event: string, handler: Handler) => {
    const handlers = map.get(event) ?? new Set<Handler>();
    handlers.add(handler);
    map.set(event, handlers);
    return () => handlers.delete(handler);
  };
  const pi = {
    events: {
      on: (event: string, handler: Handler) => on(eventHandlers, event, handler),
      emit: (event: string, data: unknown) => {
        for (const handler of eventHandlers.get(event) ?? []) handler(data);
      },
    },
    on: (event: string, handler: Handler) => on(hooks, event, handler),
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
    sendMessage: () => {
      throw new Error("bridge must not send model-context messages");
    },
  };
  const ctx = {
    mode: "rpc",
    ui: { notify: (message: string) => notifications.push(message) },
  };
  const emitHook = async (event: string, data: unknown = {}) => {
    for (const handler of hooks.get(event) ?? []) await handler(data, ctx);
  };
  return { pi, ctx, commands, notifications, eventHandlers, emitHook };
};

const loadBridge = async () => {
  const url = `data:text/javascript;base64,${Buffer.from(T3_PI_BRIDGE_EXTENSION_SOURCE).toString("base64")}`;
  return (await import(url)).default as (pi: any) => void;
};

const decodedNotifications = async (notifications: ReadonlyArray<string>) => {
  const decoded = [];
  for (const message of notifications) {
    const result = await Effect.runPromise(decodePiBridgeNotification(message));
    if (result) decoded.push(result);
  }
  return decoded;
};

describe("PiBridgeProtocol", () => {
  it.effect("round-trips valid envelopes and ignores unrelated notifications", () =>
    Effect.gen(function* () {
      const encoded = yield* encodePiBridgeNotification({
        version: 1,
        kind: "control.result",
        requestId: "request-1",
        agentId: "agent-1",
        success: true,
      });
      assert.equal(encoded.startsWith(PI_BRIDGE_PREFIX), true);
      assert.deepEqual(yield* decodePiBridgeNotification(encoded), {
        version: 1,
        kind: "control.result",
        requestId: "request-1",
        agentId: "agent-1",
        success: true,
      });
      assert.equal(yield* decodePiBridgeNotification("ordinary extension message"), undefined);
    }),
  );

  it.effect("rejects unsupported versions, statuses, and malformed JSON", () =>
    Effect.gen(function* () {
      for (const payload of [
        { version: 2, kind: "bridge.ready", targetedStop: true },
        {
          version: 1,
          kind: "task.completed",
          invocationId: "call",
          agentId: "agent",
          title: "Task",
          status: "mystery",
        },
      ]) {
        const exit = yield* decodePiBridgeNotification(
          PI_BRIDGE_PREFIX + encodeUnknownJson(payload),
        ).pipe(Effect.exit);
        assert.equal(Exit.isFailure(exit), true);
      }
      const malformed = yield* decodePiBridgeNotification(PI_BRIDGE_PREFIX + "{").pipe(Effect.exit);
      assert.equal(Exit.isFailure(malformed), true);
    }),
  );

  it.effect("writes a private self-contained extension asset", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-bridge-"));
      const extensionPath = yield* allocateT3PiBridgeExtension(root);
      assert.equal(NodeFS.readFileSync(extensionPath, "utf8"), T3_PI_BRIDGE_EXTENSION_SOURCE);
      assert.equal(NodeFS.statSync(extensionPath).mode & 0o777, 0o600);
      assert.equal(T3_PI_BRIDGE_EXTENSION_SOURCE.includes("pi.sendMessage"), false);
      assert.equal(T3_PI_BRIDGE_EXTENSION_SOURCE.includes("@tintinweb/pi-subagents"), false);
      assert.equal(T3_PI_BRIDGE_EXTENSION_SOURCE.includes("currentCtx.ui.notify"), true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("negotiates RPC v2 and flushes completion that precedes Agent tool_result", async () => {
    process.env.T3CODE_PI_BRIDGE = "1";
    const h = makeFakePi();
    h.pi.events.on("subagents:rpc:ping", (request: any) => {
      h.pi.events.emit(`subagents:rpc:ping:reply:${request.requestId}`, {
        success: true,
        data: { version: 2 },
      });
    });
    (await loadBridge())(h.pi);
    await h.emitHook("session_start");
    await Effect.runPromise(Effect.yieldNow);
    h.pi.events.emit("subagents:completed", {
      id: "agent-1",
      type: "Explore",
      description: "Inspect code",
      result: "Done",
      tokens: { input: 10, output: 4, total: 14 },
      toolUses: 3,
      durationMs: 20,
    });
    await h.emitHook("tool_result", {
      toolName: "Agent",
      toolCallId: "call-1",
      details: {
        agentId: "agent-1",
        description: "Inspect code",
        subagentType: "Explore",
        status: "completed",
      },
    });
    const events = await decodedNotifications(h.notifications);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["bridge.ready", "task.registered", "task.completed"],
    );
    assert.deepEqual(events[2], {
      version: 1,
      kind: "task.completed",
      invocationId: "call-1",
      agentId: "agent-1",
      title: "Inspect code",
      role: "Explore",
      status: "completed",
      summary: "Done",
      usage: { totalTokens: 14, inputTokens: 10, outputTokens: 4, toolUses: 3, durationMs: 20 },
    });
  });

  it("relays targeted stop success and rejects unsupported protocol versions", async () => {
    process.env.T3CODE_PI_BRIDGE = "1";
    const h = makeFakePi();
    let protocolVersion = 2;
    h.pi.events.on("subagents:rpc:ping", (request: any) => {
      h.pi.events.emit(`subagents:rpc:ping:reply:${request.requestId}`, {
        success: true,
        data: { version: protocolVersion },
      });
    });
    h.pi.events.on("subagents:rpc:stop", (request: any) => {
      h.pi.events.emit(`subagents:rpc:stop:reply:${request.requestId}`, { success: true });
    });
    (await loadBridge())(h.pi);
    await h.emitHook("session_start");
    await Effect.runPromise(Effect.yieldNow);
    const command = h.commands.get("t3code-control");
    assert.ok(command);
    const encode = (request: unknown) =>
      Buffer.from(encodeUnknownJson(request)).toString("base64url");
    await command.handler(
      encode({ version: 1, operation: "stop-subagent", requestId: "stop-1", agentId: "agent-1" }),
      h.ctx,
    );
    protocolVersion = 3;
    h.pi.events.emit("subagents:ready", {});
    await Effect.runPromise(Effect.yieldNow);
    await command.handler(
      encode({ version: 1, operation: "stop-subagent", requestId: "stop-2", agentId: "agent-2" }),
      h.ctx,
    );
    const events = await decodedNotifications(h.notifications);
    const controls = events.filter((event) => event.kind === "control.result");
    assert.deepEqual(controls, [
      {
        version: 1,
        kind: "control.result",
        requestId: "stop-1",
        agentId: "agent-1",
        success: true,
      },
      {
        version: 1,
        kind: "control.result",
        requestId: "stop-2",
        agentId: "agent-2",
        success: false,
        error: "Targeted subagent stop is unavailable.",
      },
    ]);
  });

  it("reports bounded RPC timeout and stays silent outside RPC mode", async () => {
    process.env.T3CODE_PI_BRIDGE = "1";
    process.env.T3CODE_PI_BRIDGE_RPC_TIMEOUT_MS = "10";
    const h = makeFakePi();
    (await loadBridge())(h.pi);
    await h.emitHook("session_start");
    await Effect.runPromise(Effect.sleep("20 millis"));
    const events = await decodedNotifications(h.notifications);
    assert.deepEqual(events, [{ version: 1, kind: "bridge.ready", targetedStop: false }]);

    const silent = makeFakePi();
    silent.ctx.mode = "tui";
    (await loadBridge())(silent.pi);
    await silent.emitHook("session_start");
    assert.deepEqual(silent.notifications, []);
    delete process.env.T3CODE_PI_BRIDGE_RPC_TIMEOUT_MS;
  });
});
