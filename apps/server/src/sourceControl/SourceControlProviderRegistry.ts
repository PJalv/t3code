import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  SourceControlProviderError,
  type SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import * as GerritRemotes from "@t3tools/source-control-gerrit/server/GerritRemotes";
import {
  gerritRemoteConfiguration,
  resolveRemoteEndpoint,
} from "@t3tools/source-control-gerrit/server/remoteBinding";

import * as BuiltInDrivers from "./builtInDrivers.ts";
import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  probeSourceControlProvider,
  refineUnknownRemoteProvider,
  type SourceControlProviderDiscoverySpec,
  type UnknownRemoteVerdict,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const PROVIDER_DETECTION_CACHE_CAPACITY = 2_048;
const PROVIDER_DETECTION_CACHE_TTL = Duration.seconds(5);
const UNKNOWN_REMOTE_CACHE_CAPACITY = 512;
const UNKNOWN_REMOTE_CACHE_TTL = Duration.hours(1);

export interface SourceControlProviderRegistration {
  readonly kind: SourceControlProviderKind;
  readonly provider: SourceControlProvider.SourceControlProvider["Service"];
  readonly discovery: SourceControlProviderDiscoverySpec;
}

export interface SourceControlProviderHandle {
  readonly provider: SourceControlProvider.SourceControlProvider["Service"];
  readonly context: SourceControlProvider.SourceControlProviderContext | null;
}

export class SourceControlProviderRegistry extends Context.Service<
  SourceControlProviderRegistry,
  {
    readonly resolveLink: SourceControlProvider.ResolveSourceControlLink;
    readonly get: (
      kind: SourceControlProviderKind,
    ) => Effect.Effect<
      SourceControlProvider.SourceControlProvider["Service"],
      SourceControlProviderError
    >;
    readonly resolveHandle: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    }) => Effect.Effect<SourceControlProviderHandle, SourceControlProviderError>;
    readonly resolve: (input: {
      readonly cwd: string;
    }) => Effect.Effect<
      SourceControlProvider.SourceControlProvider["Service"],
      SourceControlProviderError
    >;
    readonly discover: Effect.Effect<ReadonlyArray<SourceControlProviderDiscoveryItem>>;
  }
>()("t3/sourceControl/SourceControlProviderRegistry") {}

function unsupportedProvider(
  kind: SourceControlProviderKind,
): SourceControlProvider.SourceControlProvider["Service"] {
  // Binding context does not create a second provider-operation span.
  return SourceControlProvider.SourceControlProvider.of({
    kind,
    // Unknown hosts, and hosts whose forge a feature flag leaves out, have no readable change
    // requests; return none to avoid poll warnings on every refresh.
    listChangeRequests: Effect.fn("SourceControlProviderRegistry.unsupported.listChangeRequests")(
      () => Effect.succeed([]),
    ),
    getChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
        detail: `No ${kind} source control provider is registered.`,
      }),
    createChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "createChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.headSelector),
        detail: `No ${kind} source control provider is registered.`,
      }),

    getRepositoryCloneUrls: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getRepositoryCloneUrls",
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: `No ${kind} source control provider is registered.`,
      }),
    createRepository: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "createRepository",
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: `No ${kind} source control provider is registered.`,
      }),
    getDefaultBranch: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getDefaultBranch",
        cwd: input.cwd,
        detail: `No ${kind} source control provider is registered.`,
      }),
    checkoutChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "checkoutChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
        detail: `No ${kind} source control provider is registered.`,
      }),
  });
}

function selectProviderContext(
  remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>,
): SourceControlProvider.SourceControlProviderContext | null {
  const candidates: Array<SourceControlProvider.SourceControlProviderContext> = [];
  for (const remote of remotes) {
    const provider = sourceControlDefinitions.recognizeRemote(remote.url);
    if (provider) {
      candidates.push({
        provider,
        remoteName: remote.name,
        remoteUrl: remote.url,
      });
    }
  }

  return (
    candidates.find((candidate) => candidate.remoteName === "origin") ??
    candidates.find((candidate) => candidate.provider.kind !== "unknown") ??
    candidates[0] ??
    null
  );
}

// Failed probes are not cached, so cwd is irrelevant; equality ignores lookup, unlike Data.Class.
class UnknownRemoteLookup {
  readonly key: string;
  readonly lookup: Effect.Effect<UnknownRemoteVerdict>;

  constructor(
    context: SourceControlProvider.SourceControlProviderContext,
    lookup: Effect.Effect<UnknownRemoteVerdict>,
  ) {
    this.lookup = lookup;
    this.key = [
      context.provider.name,
      context.provider.baseUrl,
      context.remoteUrl.trim().replace(/(?<!\/\/[^/]*)[^/:]+\/[^/:]+\/?$/u, ""),
      context.requestedHost ?? "",
    ].join("\n");
  }

  [Equal.symbol](that: unknown): boolean {
    return that instanceof UnknownRemoteLookup && that.key === this.key;
  }
  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

function discoveryFingerprint(items: ReadonlyArray<SourceControlProviderDiscoveryItem>): string {
  return JSON.stringify(
    items.map((item) => [
      item.kind,
      item.status,
      item.auth.status,
      Option.getOrNull(item.auth.host),
      item.auth.accounts?.map((account) => [account.host, account.authenticated]) ?? null,
    ]),
  );
}

function bindProviderContext(
  provider: SourceControlProvider.SourceControlProvider["Service"],
  context: SourceControlProvider.SourceControlProviderContext | null,
): SourceControlProvider.SourceControlProvider["Service"] {
  if (context === null) {
    return provider;
  }

  return SourceControlProvider.SourceControlProvider.of({
    ...provider,
    listChangeRequests: Effect.fnUntraced(function* (input) {
      return yield* provider.listChangeRequests({
        ...input,
        context: input.context ?? context,
      });
    }),
    getChangeRequest: Effect.fnUntraced(function* (input) {
      return yield* provider.getChangeRequest({
        ...input,
        context: input.context ?? context,
      });
    }),
    createChangeRequest: Effect.fnUntraced(function* (input) {
      return yield* provider.createChangeRequest({
        ...input,
        context: input.context ?? context,
      });
    }),
    getRepositoryCloneUrls: Effect.fnUntraced(function* (input) {
      return yield* provider.getRepositoryCloneUrls({
        ...input,
        context: input.context ?? context,
      });
    }),
    createRepository: Effect.fnUntraced(function* (input) {
      return yield* provider.createRepository(input);
    }),
    getDefaultBranch: Effect.fnUntraced(function* (input) {
      return yield* provider.getDefaultBranch({
        ...input,
        context: input.context ?? context,
      });
    }),
    checkoutChangeRequest: Effect.fnUntraced(function* (input) {
      return yield* provider.checkoutChangeRequest({
        ...input,
        context: input.context ?? context,
      });
    }),
  });
}

/** @public */
export const makeWithProviders = Effect.fn("makeSourceControlProviderRegistryWithProviders")(
  function* (registrations: ReadonlyArray<SourceControlProviderRegistration>) {
    const config = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const { process } = yield* SourceControlHost.SourceControlHost;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const nativeRemotes = yield* GerritRemotes.GerritRemotes.pipe(
      Effect.provide(GerritRemotes.layer),
    );
    const providers = new Map<
      SourceControlProviderKind,
      SourceControlProvider.SourceControlProvider["Service"]
    >(registrations.map((registration) => [registration.kind, registration.provider]));
    const discoverySpecs = registrations.map((registration) => registration.discovery);

    const get: SourceControlProviderRegistry["Service"]["get"] = (kind) =>
      Effect.succeed(providers.get(kind) ?? unsupportedProvider(kind));

    const unknownRemoteCache = yield* Cache.makeWith(
      (request: UnknownRemoteLookup) => request.lookup,
      {
        capacity: UNKNOWN_REMOTE_CACHE_CAPACITY,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && exit.value.settled ? UNKNOWN_REMOTE_CACHE_TTL : Duration.zero,
      },
    );
    const settingsChanges = yield* serverSettings.subscribeChanges;
    yield* Stream.runForEach(settingsChanges, () => Cache.invalidateAll(unknownRemoteCache)).pipe(
      Effect.forkScoped,
    );

    let lastDiscovery: string | undefined;

    const nativeContext = Effect.fn("SourceControlProviderRegistry.nativeContext")(function* (
      cwd: string,
      remotes?: ReadonlyArray<{ readonly name: string; readonly url: string }>,
      installation?: string,
    ): Effect.fn.Return<
      SourceControlProvider.SourceControlProviderContext | null,
      SourceControlProviderError
    > {
      const connections = Object.values(
        (yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null)))
          ?.gerritConnections ?? {},
      );
      const configuration = gerritRemoteConfiguration(connections);
      if (connections.length === 0) return null;
      const endpoints =
        remotes ??
        (yield* nativeRemotes.read(cwd).pipe(
          Effect.map((observed) =>
            observed.flatMap((remote) =>
              [...remote.effective.fetch, ...remote.effective.push].map((url) => ({
                name: remote.name,
                url,
              })),
            ),
          ),
          Effect.mapError(
            (cause) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("gerrit"),
                operation: "detectProvider",
                cwd,
                detail: "Failed to read Gerrit remote endpoints.",
                cause,
              }),
          ),
        ));
      const candidates = endpoints.flatMap((remote) => {
        const endpoint = resolveRemoteEndpoint(remote.url, configuration);
        return endpoint.kind === "candidate"
          ? endpoint.repositories
              .filter(
                (repository) =>
                  installation === undefined || repository.installation === installation,
              )
              .map((repository) => ({ remote, repository }))
          : [];
      });
      const byEndpoint = endpoints
        .map(
          (remote) =>
            new Set(
              candidates
                .filter((candidate) => candidate.remote === remote)
                .map(({ repository }) =>
                  JSON.stringify([repository.installation, repository.project]),
                ),
            ),
        )
        .filter((destinations) => destinations.size > 0);
      const common = byEndpoint.reduce<Set<string> | undefined>(
        (previous, destinations) =>
          previous === undefined ? destinations : previous.intersection(destinations),
        undefined,
      );
      const installations = new Set(candidates.map(({ repository }) => repository.installation));
      if (installations.size > 1 || common?.size === 0)
        return yield* new SourceControlProviderError({
          provider: SourceControlProviderKind.make("gerrit"),
          operation: "detectProvider",
          cwd,
          detail:
            "Select a Gerrit remote and installation; multiple native repositories are configured.",
        });
      const selected = candidates[0];
      return selected === undefined
        ? null
        : {
            provider: {
              kind: SourceControlProviderKind.make("gerrit"),
              name: "Gerrit",
              baseUrl: selected.repository.installation,
            },
            remoteName: selected.remote.name,
            remoteUrl: selected.remote.url,
          };
    });
    const refineContext = Effect.fn("SourceControlProviderRegistry.refineContext")(function* (
      cwd: string,
      context: SourceControlProvider.SourceControlProviderContext | null,
    ): Effect.fn.Return<
      SourceControlProvider.SourceControlProviderContext | null,
      SourceControlProviderError
    > {
      if (context === null) return null;
      const native = yield* nativeContext(
        cwd,
        [{ name: context.remoteName, url: context.remoteUrl }],
        context.provider.kind === "gerrit" ? context.provider.baseUrl : undefined,
      );
      if (native !== null) return { ...context, provider: native.provider };
      if (context.provider.kind === "gerrit")
        return yield* new SourceControlProviderError({
          provider: context.provider.kind,
          operation: "detectProvider",
          cwd,
          detail: "The selected Gerrit remote is not bound to this installation.",
        });
      if (context.provider.kind !== "unknown") return context;
      const { provider } = yield* Cache.get(
        unknownRemoteCache,
        new UnknownRemoteLookup(
          context,
          refineUnknownRemoteProvider({ specs: discoverySpecs, process, cwd, context }),
        ),
      );
      return provider ? { ...context, provider } : context;
    });

    const detectProviderContext = Effect.fn("SourceControlProviderRegistry.detectProviderContext")(
      function* (cwd: string) {
        const handle = yield* vcsRegistry.resolve({ cwd }).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("unknown"),
                operation: "detectProvider",
                cwd,
                detail: "Failed to detect source control provider.",
                cause: error,
              }),
          ),
        );
        const remotes = yield* handle.driver.listRemotes(cwd).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("unknown"),
                operation: "detectProvider",
                cwd,
                detail: "Failed to detect source control provider.",
                cause: error,
              }),
          ),
        );
        const native = yield* nativeContext(cwd);
        return native ?? (yield* refineContext(cwd, selectProviderContext(remotes.remotes)));
      },
    );

    const providerContextCache = yield* Cache.makeWith<
      string,
      SourceControlProvider.SourceControlProviderContext | null,
      SourceControlProviderError
    >(detectProviderContext, {
      capacity: PROVIDER_DETECTION_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? PROVIDER_DETECTION_CACHE_TTL : Duration.zero),
    });

    const connectionChanges = yield* serverSettings.subscribeChanges;
    yield* Stream.runForEach(connectionChanges, () =>
      Effect.all(
        [Cache.invalidateAll(unknownRemoteCache), Cache.invalidateAll(providerContextCache)],
        { discard: true },
      ),
    ).pipe(Effect.forkScoped);

    const resolveHandle: SourceControlProviderRegistry["Service"]["resolveHandle"] = (input) =>
      (input.context === undefined
        ? Cache.get(providerContextCache, input.cwd)
        : refineContext(input.cwd, input.context)
      ).pipe(
        Effect.map((context) => {
          const kind = context?.provider.kind ?? SourceControlProviderKind.make("unknown");
          const provider = providers.get(kind) ?? unsupportedProvider(kind);
          return {
            provider: bindProviderContext(provider, context),
            context,
          } satisfies SourceControlProviderHandle;
        }),
      );

    return SourceControlProviderRegistry.of({
      resolveLink: (input) => {
        if (input.url.protocol !== "https:" || input.url.username || input.url.password) {
          return undefined;
        }
        const kind = sourceControlDefinitions.recognizeRemote(input.url.href)?.kind;
        return kind ? providers.get(kind)?.resolveLink?.(input) : undefined;
      },
      get,
      resolveHandle,
      resolve: Effect.fn("SourceControlProviderRegistry.resolve")(function (input) {
        return resolveHandle(input).pipe(Effect.map((handle) => handle.provider));
      }),
      discover: Effect.forEach(
        discoverySpecs,
        (spec) =>
          probeSourceControlProvider({
            spec,
            process,
            cwd: config.cwd,
          }),
        { concurrency: "unbounded" },
      ).pipe(
        // A CLI installed or signed in since the last check may claim a remote no forge claimed.
        Effect.tap((items) => {
          const fingerprint = discoveryFingerprint(items);
          if (fingerprint === lastDiscovery) return Effect.void;
          const changed = lastDiscovery !== undefined;
          lastDiscovery = fingerprint;
          return changed ? Cache.invalidateAll(unknownRemoteCache) : Effect.void;
        }),
      ),
    });
  },
);

const make = Effect.gen(function* () {
  const drivers = yield* BuiltInDrivers.SourceControlDrivers;
  return yield* makeWithProviders(
    drivers.map(({ driver, instance }): SourceControlProviderRegistration => ({
      kind: driver.kind,
      provider: instance.sourceControl,
      discovery: instance.discovery,
    })),
  );
});

export const layer = Layer.effect(SourceControlProviderRegistry, make);
