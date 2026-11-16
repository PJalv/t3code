import { it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as GerritHttp from "@t3tools/source-control-gerrit/server/GerritHttp";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpClient from "effect/http/HttpClient";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Layer from "effect/Layer";
import * as GerritDriver from "@t3tools/source-control-gerrit/server/driver";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { fromProviders } from "./PullRequestProviderRegistry.ts";

it.effect("returns the Gerrit driver's pull request API", () =>
  Effect.gen(function* () {
    const driver = yield* GerritDriver.driver.make.pipe(
      Effect.provideService(GerritHttp.GerritHttp, {} as GerritHttp.GerritHttp["Service"]),
      Effect.provideService(SourceControlHost.SourceControlHost, {
        settings: { get: Effect.succeed({ gerritConnections: {} }) },
      } as unknown as SourceControlHost.SourceControlHost["Service"]),
      Effect.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          NodeServices.layer,
          SourceControlRateLimit.layer,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Unexpected HTTP")),
          ),
        ),
      ),
    );
    const api = driver.pullRequests;
    if (!api) return yield* Effect.die("Missing pull request API");
    const registry = fromProviders([api]);
    expect(registry.get(SourceControlProviderKind.make("gerrit"))).toBe(api);
    expect(registry.kinds).toContain("gerrit");
  }),
);
