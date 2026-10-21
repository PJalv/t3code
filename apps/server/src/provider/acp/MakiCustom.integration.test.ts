import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it, expect } from "@effect/vitest";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as Deferred from "effect/Deferred";
import { HttpClient } from "effect/http";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { probeAcpRegistryConfiguration } from "@t3tools/provider-acp-registry/testing";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeEffect(AcpRegistrySettings);
const enabled = process.env.T3_MAKI_ACP_INTEGRATION === "1";

// Opt in because this launches a real agent with the operator's existing profile.
it.effect("Nix Maki runs through T3 custom ACP transport with the existing profile", () =>
  Effect.gen(function* () {
    if (!enabled) return;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-maki-custom-integration-" });
    const cwd = `${root}/workspace`;
    yield* fs.makeDirectory(cwd);
    const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
      cacheDir: `${root}/cache`,
      toolsDir: `${root}/tools`,
    });
    const settings = yield* decodeSettings({
      source: "local",
      commandPath: "nix",
      commandArgs: ["run", "github:tontinton/maki", "--", "acp"],
    });
    expect(yield* catalog.inspect(settings)).toMatchObject({ status: "ready" });
    const probe = yield* probeAcpRegistryConfiguration({
      instanceId: ProviderInstanceId.make("acpRegistry_maki_verification"),
      settings,
      cwd,
      environment: process.env,
    }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog));
    expect(probe.probe.models.length).toBeGreaterThan(0);
    const resolved = yield* catalog.resolve(settings, cwd, process.env);
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: resolved.spawn,
        cwd,
        clientInfo: { name: "t3-custom-acp-verification", version: "0.0.0" },
        authenticateOnAuthRequired: false,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }).pipe(Layer.provide(NodeServices.layer)),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(context),
    );
    const initialize = yield* runtime.initialize();
    const answerRef = yield* Ref.make("");
    yield* runtime.getEvents().pipe(
      Stream.runForEach((event) =>
        event._tag === "EventStreamBarrier"
          ? Deferred.succeed(event.acknowledge, undefined)
          : event._tag === "ContentDelta"
            ? Ref.update(answerRef, (text) => text + event.text)
            : Effect.void,
      ),
      Effect.forkScoped,
    );
    yield* runtime.start();
    const modes = yield* runtime.getModeState;
    const config = yield* runtime.getConfigOptions;
    yield* runtime.setMode("plan");
    expect((yield* runtime.getModeState)?.currentModeId).toBe("plan");
    const model = config.find((option) => option.category === "model");
    if (model?.type === "select" && typeof model.currentValue === "string") {
      yield* runtime.setModel(model.currentValue);
    }
    const response = yield* runtime.prompt({
      prompt: [
        {
          type: "text",
          text: "Reply with exactly ACP_OK. Do not read or write files, run tools, or change configuration.",
        },
      ],
    });
    expect(response.stopReason).toBe("end_turn");
    yield* runtime.drainEvents;
    const answer = yield* Ref.get(answerRef);
    expect(answer.trim()).toBe("ACP_OK");
    expect(yield* fs.readDirectory(cwd)).toEqual([]);
    expect(yield* fs.exists(`${root}/tools`)).toBe(false);
    yield* fs.writeFileString(
      "/tmp/custom-acp-maki-evidence.json",
      encodeEvidence({
        command: "nix run github:tontinton/maki -- acp",
        transport: "T3 AcpSessionRuntime",
        existingHome: true,
        registryRequests: 0,
        initialize: {
          protocolVersion: initialize.protocolVersion,
          agentInfo: initialize.agentInfo,
          agentCapabilities: initialize.agentCapabilities,
          authMethodIds: initialize.authMethods?.map((m) => m.id),
        },
        probe: {
          models: probe.probe.models,
          configOptions: probe.probe.configOptions,
          sessionManagement: probe.probe.sessionManagement,
        },
        modes,
        modeSwitch: "plan",
        config,
        promptResponse: response,
        answer,
        workspaceUntouched: true,
      }),
    );
  }).pipe(
    Effect.scoped,
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Registry access forbidden")),
    ),
    Effect.provide(
      TestProviderHost.layer().pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
