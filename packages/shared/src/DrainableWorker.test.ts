import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeDrainableWorker, makeKeyedDrainableWorker } from "./DrainableWorker.ts";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );
});

describe("makeKeyedDrainableWorker", () => {
  it.live("preserves per-key order without cross-key head-of-line blocking", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const noisyStarted = yield* Deferred.make<void>();
        const releaseNoisy = yield* Deferred.make<void>();
        const quietProcessed = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker<string, string>((item) =>
          Effect.gen(function* () {
            if (item === "noisy-first") {
              yield* Deferred.succeed(noisyStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseNoisy);
            }
            processed.push(item);
            if (item === "quiet") {
              yield* Deferred.succeed(quietProcessed, undefined).pipe(Effect.orDie);
            }
          }),
        );

        yield* worker.enqueue("noisy", "noisy-first");
        yield* worker.enqueue("noisy", "noisy-second");
        yield* Deferred.await(noisyStarted);

        yield* worker.enqueue("quiet", "quiet");
        yield* Deferred.await(quietProcessed);
        expect(processed).toEqual(["quiet"]);

        yield* Deferred.succeed(releaseNoisy, undefined);
        yield* worker.drain;
        expect(processed).toEqual(["quiet", "noisy-first", "noisy-second"]);
      }),
    ),
  );
});
