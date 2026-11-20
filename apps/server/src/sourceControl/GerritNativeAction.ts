import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface Action {
  readonly server: string;
  readonly project: string;
  readonly number: number;
  readonly operation: "submit" | "abandon";
  /** Other changes the submit merges with this one, such as the rest of its topic. */
  readonly together?: ReadonlyArray<{ readonly project: string; readonly number: number }>;
}

// The caller that knows the acting thread provides this; the service doing the Gerrit write
// supplies the resolved change and its successful write. Kept apart from GerritWatchCompletion so
// the pull request service can read it without loading the orchestrator.
export const NativeAction = Context.Reference<
  <A, E, R>(action: Action, write: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
>("t3/sourceControl/GerritNativeAction", {
  defaultValue: () => (_, write) => write,
});
