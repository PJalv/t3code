import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export class GitHttpAuth extends Context.Service<
  GitHttpAuth,
  {
    readonly entries: Effect.Effect<ReadonlyArray<readonly [string, string]>>;
    readonly invalidate: Effect.Effect<void>;
  }
>()("t3/vcs/GitHttpAuth") {}
