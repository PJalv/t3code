import type {
  SourceControlDriver,
  SourceControlDriverInstance,
} from "@t3tools/source-control-core/server/driver";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as GerritBranchReviews from "./gerritBranchReviews.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";
import { BUILT_IN_SOURCE_CONTROL_DRIVER_LIST } from "./sourceControlDefinitions.ts";

export interface SourceControlDriverEntry {
  readonly driver: Pick<SourceControlDriver, "kind" | "definition">;
  readonly instance: SourceControlDriverInstance;
}

/** Every driver's instance, in registry order. Everything that reads a host reads it here. */
export class SourceControlDrivers extends Context.Service<
  SourceControlDrivers,
  ReadonlyArray<SourceControlDriverEntry>
>()("t3/sourceControl/builtInDrivers/SourceControlDrivers") {}

const make = Effect.forEach(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST, (driver) =>
  driver.make.pipe(Effect.map((instance) => ({ driver, instance }))),
);

export const layer = Layer.effect(SourceControlDrivers, make).pipe(
  // The Gerrit driver reads its credential and branch-review resolvers as optional services:
  // both need the settings file and secret store, which the driver itself does not require.
  Layer.provide(
    Layer.mergeAll(
      GerritBranchReviews.layer,
      GerritBranchReviews.layerGerritCredentialResolver,
    ).pipe(Layer.provide(ServerSecretStore.layer)),
  ),
  Layer.provideMerge(ServerSourceControlHost.layer),
  Layer.provideMerge(SourceControlRateLimit.layer),
);
