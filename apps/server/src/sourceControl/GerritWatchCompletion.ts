import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { threadPullRequestKeysEqual, visibleThreadPullRequests } from "./threadPullRequests.ts";

interface Action {
  readonly server: string;
  readonly project: string;
  readonly number: number;
  readonly operation: "submit" | "abandon";
}

// The handler supplies the caller; the service supplies the resolved identity and successful write.
export const NativeAction = Context.Reference<
  <A, E, R>(
    action: Action,
    write: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | Orchestrator.OrchestratorV2Error, R>
>("t3/sourceControl/GerritWatchCompletion/NativeAction", {
  defaultValue: () => (_, write) => write,
});

export class GerritWatchCompletion extends Context.Service<
  GerritWatchCompletion,
  {
    readonly action: <A, E, R>(
      threadId: ThreadId,
      action: Action,
      write: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | Orchestrator.OrchestratorV2Error, R>;
    readonly completion: <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/sourceControl/GerritWatchCompletion") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;
  const gates = new Map<ThreadId, { readonly semaphore: Semaphore.Semaphore; users: number }>();
  // Unrelated threads must not wait for a slow native write; release idle gates as watches end.
  const completion = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const gate = gates.get(threadId) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      gates.set(threadId, gate);
      gate.users++;
      return gate.semaphore.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (--gate.users === 0) gates.delete(threadId);
          }),
        ),
      );
    });
  const action = Effect.fn("GerritWatchCompletion.action")(
    function* <A, E, R>(threadId: ThreadId, action: Action, write: Effect.Effect<A, E, R>) {
      const key = {
        host: new URL(action.server).host,
        repository: action.project,
        number: action.number,
      };
      const thread = yield* engine.getThreadShell(threadId);
      const installation = new URL(action.server);
      const basePath = installation.pathname.replace(/\/$/u, "");
      const link = visibleThreadPullRequests(thread?.pullRequests ?? []).find((link) => {
        const url = URL.parse(link.url);
        return (
          threadPullRequestKeysEqual(link, key) &&
          link.repository === action.project &&
          url?.origin === installation.origin &&
          url.pathname.startsWith(`${basePath}/c/`)
        );
      });
      // A watch restarted during the request belongs to the new observer, not this action.
      const watch = link?.watch;
      // Record a confirmed write even if the caller disconnects before the detail reread.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* restore(write);
          if (watch !== undefined) {
            // Gerrit already applied the write; a watch stopped or restarted meanwhile only means
            // there is nothing to clear, and the caller must still hear that the action succeeded.
            yield* engine
              .dispatch({
                type: "thread.pull-request-watch.sync",
                commandId: CommandId.make(
                  `server:gerrit-${action.operation}:${yield* random.uuidV4()}`,
                ),
                threadId,
                ...key,
                startedAt: watch.startedAt,
                watch: null,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Gerrit watch was not cleared after a native action", {
                    threadId,
                    operation: action.operation,
                    cause,
                  }),
                ),
              );
          }
          return result;
        }),
      );
    },
    (effect, threadId) => completion(threadId, effect),
  );
  return GerritWatchCompletion.of({ action, completion });
});

export const layer = Layer.effect(GerritWatchCompletion, make);
