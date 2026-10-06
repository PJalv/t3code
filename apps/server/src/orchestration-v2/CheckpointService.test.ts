import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "./IdAllocator.ts";

it.effect("disables baseline and completion snapshots without invoking Git", () =>
  Effect.gen(function* () {
    const previous = process.env.T3_DISABLE_CHECKPOINTS;
    process.env.T3_DISABLE_CHECKPOINTS = "1";
    try {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("scope:disabled"),
        threadId: ThreadId.make("thread:disabled"),
        runId: RunId.make("run:disabled"),
        nodeId: NodeId.make("node:disabled"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider:disabled"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      const testLayer = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: () => Effect.die("disabled checkpoints must not invoke Git"),
              hasCheckpointRef: () => Effect.die("disabled checkpoints must not look up refs"),
              captureCheckpoint: () => Effect.die("disabled checkpoints must not capture"),
              diffCheckpoints: () => Effect.die("disabled checkpoints must not diff"),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
        const baseline = yield* checkpoints.materializeBaselineCheckpoint({
          scope,
          ordinalWithinScope: 0,
        });
        const completion = yield* checkpoints.capture({
          scope,
          ordinalWithinScope: 1,
          runId: scope.runId!,
          nodeId: scope.nodeId!,
          appRunOrdinal: 1,
          capturedAt: scope.createdAt,
        });
        assert.equal(baseline.status, "missing");
        assert.equal(completion.status, "missing");
        assert.deepEqual(completion.files, []);
      }).pipe(Effect.provide(testLayer));
    } finally {
      if (previous === undefined) delete process.env.T3_DISABLE_CHECKPOINTS;
      else process.env.T3_DISABLE_CHECKPOINTS = previous;
    }
  }),
);

it.effect.each([false, true, "interrupt"] as const)(
  "materializes baseline, lookup fails=%s",
  (lookupFails) => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
      threadId: ThreadId.make("thread:materialize-baseline"),
      runId: RunId.make("run:materialize-baseline:3"),
      nodeId: NodeId.make("node:materialize-baseline:3"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const hasCheckpointRef = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
      lookupFails === "interrupt"
        ? Effect.interrupt
        : lookupFails
          ? Effect.fail(
              new VcsProcessTimeoutError({
                operation: "test.ref",
                command: "git",
                cwd: "/repo",
                timeoutMs: 30000,
              }),
            )
          : Effect.succeed(true),
    );
    const testLayer = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef,
            captureCheckpoint: () => Effect.void,
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      if (lookupFails === "interrupt") {
        const exit = yield* Effect.exit(
          checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 2 }),
        );
        assert.isTrue(Exit.hasInterrupts(exit));
        const captureExit = yield* Effect.exit(
          checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          }),
        );
        assert.isTrue(Exit.hasInterrupts(captureExit));
        return;
      }
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 2,
      });

      assert.equal(baseline.ordinalWithinScope, 2);
      assert.equal(
        baseline.ref,
        CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 2,
        }),
      );
      assert.equal(baseline.status, lookupFails ? "missing" : "ready");
      assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
        cwd: scope.cwd,
        checkpointRef: baseline.ref,
      });
    }).pipe(Effect.provide(testLayer));
  },
);
