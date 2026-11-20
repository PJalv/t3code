import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type * as GerritNativeAction from "./GerritNativeAction.ts";
import { threadPullRequestKeysEqual, visibleThreadPullRequests } from "./threadPullRequests.ts";

export class GerritWatchCompletion extends Context.Service<
  GerritWatchCompletion,
  {
    readonly action: <A, E, R>(
      threadId: ThreadId,
      action: GerritNativeAction.Action,
      write: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
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
    function* <A, E, R>(
      threadId: ThreadId,
      action: GerritNativeAction.Action,
      write: Effect.Effect<A, E, R>,
    ) {
      const installation = new URL(action.server);
      const basePath = installation.pathname.replace(/\/$/u, "");
      // Clearing watches is bookkeeping; an unreadable thread costs a duplicate wake, not the write.
      const thread = yield* engine.getThreadShell(threadId).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Gerrit watches were not read before a native action", {
            threadId,
            operation: action.operation,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      const links = visibleThreadPullRequests(thread?.pullRequests ?? []);
      const watches = [action, ...(action.together ?? [])].flatMap((change) => {
        const key = { host: installation.host, repository: change.project, number: change.number };
        const link = links.find((link) => {
          const url = URL.parse(link.url);
          return (
            threadPullRequestKeysEqual(link, key) &&
            link.repository === change.project &&
            url?.origin === installation.origin &&
            url.pathname.startsWith(`${basePath}/c/`)
          );
        });
        // A watch restarted during the request belongs to the new observer, not this action.
        return link?.watch === undefined ? [] : [{ key, startedAt: link.watch.startedAt }];
      });
      // Record a confirmed write even if the caller disconnects before the detail reread.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* restore(write);
          yield* Effect.forEach(
            watches,
            ({ key, startedAt }) =>
              Effect.gen(function* () {
                yield* engine.dispatch({
                  type: "thread.pull-request-watch.sync",
                  commandId: CommandId.make(
                    `server:gerrit-${action.operation}:${yield* random.uuidV4()}`,
                  ),
                  threadId,
                  ...key,
                  startedAt,
                  watch: null,
                });
              }).pipe(
                // Gerrit already applied the write; a watch stopped or restarted meanwhile only
                // means there is nothing to clear, and the caller must still hear that it succeeded.
                Effect.catchCause((cause) =>
                  Option.exists(
                    Cause.findErrorOption(cause),
                    Orchestrator.isPullRequestWatchMovedError,
                  )
                    ? Effect.void
                    : Effect.logWarning("Gerrit watch was not cleared after a native action", {
                        threadId,
                        operation: action.operation,
                        cause,
                      }),
                ),
              ),
            { discard: true },
          );
          return result;
        }),
      );
    },
    (effect, threadId) => completion(threadId, effect),
  );
  return GerritWatchCompletion.of({ action, completion });
});

export const layer = Layer.effect(GerritWatchCompletion, make);
