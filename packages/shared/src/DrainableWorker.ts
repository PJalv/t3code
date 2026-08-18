/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * Keyed worker over independent per-key serial lanes. `enqueue` may lazily
 * create a lane, so it needs a `Scope` to fork that lane into and carries the
 * same `E`/`R` requirements as `process`. `drain` waits on every lane created
 * so far and needs no extra context.
 */
export interface KeyedDrainableWorker<K, A, E = never, R = never> {
  /** Enqueue work in the serial lane selected by its key. */
  readonly enqueue: (key: K, item: A) => Effect.Effect<void, E, R | Scope.Scope>;

  /** Resolves when every key lane created so far is drained. */
  readonly drain: Effect.Effect<void>;
}

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown);
    const outstanding = yield* TxRef.make(0);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        Effect.ensuring(
          process(a),
          TxRef.update(outstanding, (n) => n - 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });

/**
 * Create independent serial workers for keyed work.
 *
 * Items with the same key retain strict enqueue order. Different keys process
 * concurrently, so a noisy or slow key cannot block unrelated work. Workers
 * live for the parent scope and are created atomically on first use.
 *
 * Curried so the key type is fixed explicitly while the item/error/context
 * types are inferred from the handler: `makeKeyedDrainableWorker<K>()(fn)`.
 */
export const makeKeyedDrainableWorker =
  <K>() =>
  <A, E, R>(
    process: (item: A) => Effect.Effect<void, E, R>,
  ): Effect.Effect<KeyedDrainableWorker<K, A, E, R>, never, Scope.Scope | R> =>
    Effect.gen(function* () {
      const workersRef = yield* SynchronizedRef.make<ReadonlyMap<K, DrainableWorker<A>>>(new Map());

      const workerFor = (key: K) =>
        SynchronizedRef.modifyEffect(workersRef, (workers) => {
          const existing = workers.get(key);
          if (existing !== undefined) {
            return Effect.succeed([existing, workers] as const);
          }
          return makeDrainableWorker(process).pipe(
            Effect.map((worker) => {
              const next = new Map(workers);
              next.set(key, worker);
              return [worker, next as ReadonlyMap<K, DrainableWorker<A>>] as const;
            }),
          );
        });

      const enqueue = (key: K, item: A) =>
        workerFor(key).pipe(Effect.flatMap((worker) => worker.enqueue(item)));

      const drain = SynchronizedRef.get(workersRef).pipe(
        Effect.flatMap((workers) =>
          Effect.forEach(workers.values(), (worker) => worker.drain, {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
      );

      return { enqueue, drain } satisfies KeyedDrainableWorker<K, A, E, R>;
    });
