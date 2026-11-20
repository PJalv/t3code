import { it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { expect } from "vite-plus/test";
import * as GerritDriver from "./driver.ts";
import * as GerritHttp from "./GerritHttp.ts";

const probe = (installations: ReadonlyArray<string>, withCredentials: ReadonlyArray<string>) =>
  GerritDriver.driver.make.pipe(
    Effect.flatMap((driver) =>
      driver.discovery.type === "api"
        ? driver.discovery.probeAuth
        : Effect.die("Gerrit discovery should be an API probe"),
    ),
    Effect.provideService(GerritHttp.GerritHttp, {} as GerritHttp.GerritHttp["Service"]),
    Effect.provideService(SourceControlHost.SourceControlHost, {
      settings: {
        get: Effect.succeed({
          gerritConnections: Object.fromEntries(
            installations.map((installation) => [installation, { installation }]),
          ),
        }),
      },
    } as unknown as SourceControlHost.SourceControlHost["Service"]),
    Effect.provideService(GerritDriver.GerritPullRequestCredentialResolver, (server) =>
      withCredentials.includes(server)
        ? Effect.succeed({} as never)
        : Effect.fail(
            new PullRequestProviderError({
              provider: SourceControlProviderKind.make("gerrit"),
              operation: "credentials",
              reason: "unauthenticated",
              detail: "missing",
            }),
          ),
    ),
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

it.effect("counts Gerrit servers with saved credentials as connected", () =>
  Effect.gen(function* () {
    const a = "https://a.example.com/";
    const b = "https://b.example.com/";

    const none = yield* probe([], []);
    expect(none.status).toBe("unauthenticated");

    const missing = yield* probe([a], []);
    expect(missing.status).toBe("unauthenticated");

    const both = yield* probe([a, b], [a, b]);
    expect(both.status).toBe("authenticated");
    expect(Option.getOrNull(both.detail)).toBe("2 servers connected");

    const partial = yield* probe([a, b], [a]);
    expect(partial.status).toBe("authenticated");
    expect(Option.getOrNull(partial.detail)).toBe("1 server connected, 1 missing credentials");
  }),
);
