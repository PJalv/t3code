import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const encoder = new TextEncoder();

const emptyNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {};
const lanNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {
  en0: [
    {
      address: "192.168.1.20",
      family: "IPv4",
      internal: false,
    },
  ],
};

const tailnetNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {
  tailscale0: [
    {
      address: "100.90.1.2",
      family: "IPv4",
      internal: false,
    },
  ],
};

const multiHomedNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {
  docker0: [
    {
      address: "172.17.0.1",
      family: "IPv4",
      internal: false,
    },
  ],
  en0: [
    {
      address: "192.168.1.20",
      family: "IPv4",
      internal: false,
    },
  ],
  en1: [
    {
      address: "192.168.1.21",
      family: "IPv4",
      internal: false,
    },
  ],
};

function layerMockSpawner(statusJson: string | (() => string) = "{}", onSpawn?: () => void) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        onSpawn?.();
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(
            encoder.encode(typeof statusJson === "string" ? statusJson : statusJson()),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );
}

function layerEnvironmentFor(baseDir: string, env: Record<string, string | undefined> = {}) {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        DesktopConfig.layerTest({ T3CODE_HOME: baseDir, ...env }),
      ),
    ),
  );
}

function layer(input: {
  readonly baseDir: string;
  readonly networkInterfaces?: DesktopNetworkInterfaces.NetworkInterfaces;
  readonly env?: Record<string, string | undefined>;
  readonly spawnerLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly desktopSettingsLayer?: Layer.Layer<DesktopAppSettings.DesktopAppSettings>;
  readonly managedPolicyLayer?: Layer.Layer<DesktopManagedPolicy.DesktopManagedPolicy>;
}) {
  const env = { T3CODE_HOME: input.baseDir, ...input.env };
  const layerEnvironment = layerEnvironmentFor(input.baseDir, env);
  const layerNetwork = Layer.succeed(DesktopNetworkInterfaces.DesktopNetworkInterfaces, {
    read: Effect.succeed(input.networkInterfaces ?? emptyNetworkInterfaces),
  });

  return DesktopServerExposure.layer.pipe(
    Layer.provideMerge(input.desktopSettingsLayer ?? DesktopAppSettings.layer),
    Layer.provideMerge(input.managedPolicyLayer ?? DesktopManagedPolicy.layerTest()),
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provideMerge(NodeHttpClient.layerUndici),
    Layer.provideMerge(input.spawnerLayer ?? layerMockSpawner()),
    Layer.provideMerge(layerNetwork),
    Layer.provideMerge(DesktopConfig.layerTest(env)),
    Layer.provideMerge(layerEnvironment),
  );
}

const withHarness = <A, E, R>(
  networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces,
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopServerExposure.DesktopServerExposure
    | DesktopAppSettings.DesktopAppSettings
  >,
  env: Record<string, string | undefined> = {},
  spawnerLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  desktopSettingsLayer?: Layer.Layer<DesktopAppSettings.DesktopAppSettings>,
  managedPolicyLayer?: Layer.Layer<DesktopManagedPolicy.DesktopManagedPolicy>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-server-exposure-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        layer({
          baseDir,
          networkInterfaces,
          env,
          ...(spawnerLayer ? { spawnerLayer } : {}),
          ...(desktopSettingsLayer ? { desktopSettingsLayer } : {}),
          ...(managedPolicyLayer ? { managedPolicyLayer } : {}),
        }),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped);

describe("DesktopServerExposure", () => {
  it.effect("uses cached Tailscale identity to exclude another VPN's pairing address", () => {
    let statusReads = 0;
    return withHarness(
      {
        ...lanNetworkInterfaces,
        pvpnksintrf1: [{ address: "100.85.0.1", family: "IPv4", internal: false }],
        vpn0: [{ address: "100.74.126.34", family: "IPv4", internal: false }],
      },
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        yield* serverExposure.setMode("network-accessible");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/", "http://192.168.1.20:4173/", "http://100.74.126.34:4173/"],
        );
        assert.deepEqual(yield* serverExposure.getAdvertisedEndpoints, endpoints);
        assert.equal(statusReads, 1);
      }),
      {},
      layerMockSpawner(`{"Self":{"TailscaleIPs":["100.74.126.34"]}}`, () => {
        statusReads += 1;
      }),
    );
  });

  it.effect("falls back to local-only without losing the requested network preference", () =>
    withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.setServerExposureMode("network-accessible");

        const state = yield* serverExposure.configureFromSettings({ port: 4173 });
        assert.equal(state.mode, "local-only");
        assert.equal(state.endpointUrl, null);
        assert.equal((yield* settings.get).serverExposureMode, "network-accessible");

        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.bindHost, "127.0.0.1");
        assert.equal(backendConfig.httpBaseUrl.href, "http://127.0.0.1:4173/");
      }),
    ),
  );

  it.effect("starts local-only, Serve off, when a managed policy keeps clients local", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setServerExposureMode("network-accessible");
        yield* settings.setTailscaleServe({ enabled: true, port: Option.none() });

        const state = yield* serverExposure.configureFromSettings({ port: 4173 });
        assert.equal(state.mode, "local-only");
        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.bindHost, "127.0.0.1");
        assert.isFalse(backendConfig.tailscaleServeEnabled);
        // Choosing them again while the policy applies does not widen the backend either.
        yield* serverExposure.setMode("network-accessible");
        yield* serverExposure.setTailscaleServeEnabled({ enabled: true });
        assert.equal((yield* serverExposure.backendConfig).bindHost, "127.0.0.1");
        assert.isFalse((yield* serverExposure.backendConfig).tailscaleServeEnabled);
        // The saved choice returns once the policy allows it.
        const saved = yield* settings.get;
        assert.equal(saved.serverExposureMode, "network-accessible");
        assert.isTrue(saved.tailscaleServeEnabled);
      }),
      {},
      undefined,
      undefined,
      DesktopManagedPolicy.layerTest({
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { clients: ["desktop"] },
      }),
    ),
  );

  it.effect("persists network-accessible mode and updates backend binding state", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.load;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const change = yield* serverExposure.setMode("network-accessible");
        assert.equal(change.requiresRelaunch, true);
        assert.deepEqual(change.state, {
          mode: "network-accessible",
          endpointUrl: "http://192.168.1.20:4173",
          advertisedHost: "192.168.1.20",
          preferredLanInterfaceName: null,
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        });

        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.bindHost, "0.0.0.0");
        assert.equal(backendConfig.httpBaseUrl.href, "http://127.0.0.1:4173/");

        const persisted = yield* settings.get;
        assert.equal(persisted.serverExposureMode, "network-accessible");
      }),
    ),
  );

  it.effect("advertises the Wi-Fi or Ethernet address ahead of bridges and tunnels", () =>
    withHarness(
      {
        bridge0: [{ address: "192.168.2.1", family: "IPv4", internal: false }],
        utun4: [{ address: "10.8.0.2", family: "IPv4", internal: false }],
        en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
      },
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const change = yield* serverExposure.setMode("network-accessible");
        assert.equal(change.state.advertisedHost, "192.168.1.20");
      }),
    ),
  );

  it.effect("advertises the current LAN address after the network changes", () => {
    const networkInterfaces: Record<
      string,
      readonly DesktopNetworkInterfaces.DesktopNetworkInterfaceInfo[] | undefined
    > = { ...lanNetworkInterfaces };

    return withHarness(
      networkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        yield* serverExposure.setMode("network-accessible");

        networkInterfaces.en0 = [{ address: "10.0.0.5", family: "IPv4", internal: false }];

        const state = yield* serverExposure.getState;
        assert.equal(state.advertisedHost, "10.0.0.5");
        assert.equal(state.endpointUrl, "http://10.0.0.5:4173");
        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/", "http://10.0.0.5:4173/"],
        );
        assert.equal((yield* serverExposure.backendConfig).bindHost, "0.0.0.0");
      }),
    );
  });

  it.effect("advertises one endpoint per physical interface and skips virtual bridges", () =>
    withHarness(
      multiHomedNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setServerExposureMode("network-accessible");
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const state = yield* serverExposure.getState;
        assert.equal(state.advertisedHost, "192.168.1.20");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints
            .filter((endpoint) => endpoint.id.startsWith("desktop-lan:"))
            .map((endpoint) => [endpoint.label, endpoint.httpBaseUrl, endpoint.interfaceName]),
          [
            ["Local network", "http://192.168.1.20:4173/", "en0"],
            ["Local network - en1 (192.168.1.21)", "http://192.168.1.21:4173/", "en1"],
          ],
        );
      }),
    ),
  );

  it.effect("treats Windows virtual adapters with parentheses as virtual", () =>
    withHarness(
      {
        "vEthernet (Default Switch)": [{ address: "172.25.32.1", family: "IPv4", internal: false }],
        ...multiHomedNetworkInterfaces,
      },
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setServerExposureMode("network-accessible");
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.isFalse(endpoints.some((endpoint) => endpoint.httpBaseUrl.includes("172.25.32.1")));
      }),
    ),
  );

  it.effect("advertises every physical interface without truncation", () =>
    withHarness(
      Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [
          `en${index}`,
          [{ address: `10.0.0.${index + 2}`, family: "IPv4", internal: false }],
        ]),
      ),
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setServerExposureMode("network-accessible");
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        const lanEndpoints = endpoints.filter((endpoint) => endpoint.id.startsWith("desktop-lan:"));
        assert.equal(lanEndpoints.length, 10);
      }),
    ),
  );

  it.effect("re-resolves the default endpoint when interfaces change after startup", () => {
    const interfaces: Record<string, DesktopNetworkInterfaces.NetworkInterfaces[string]> = {
      ...multiHomedNetworkInterfaces,
    };
    return withHarness(
      interfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setServerExposureMode("network-accessible");
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const preferred = yield* serverExposure.setPreferredLanInterfaceName({ name: "en0" });
        assert.equal(preferred.state.advertisedHost, "192.168.1.20");

        // The harness network service returns the fixture object by
        // reference, so removing en0 here simulates it disappearing after
        // the exposure state was resolved at startup.
        delete interfaces.en0;
        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        const defaultEndpoint = endpoints.find(
          (endpoint) => endpoint.id.startsWith("desktop-lan:") && endpoint.isDefault === true,
        );
        assert.equal(defaultEndpoint?.httpBaseUrl, "http://192.168.1.21:4173/");
        assert.isFalse(endpoints.some((endpoint) => endpoint.httpBaseUrl.includes("192.168.1.20")));
        const refreshed = yield* serverExposure.getState;
        assert.equal(refreshed.advertisedHost, "192.168.1.21");
      }),
    );
  });

  it.effect("downgrades to loopback when only virtual interfaces exist", () =>
    withHarness(
      {
        docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
      },
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setServerExposureMode("network-accessible");
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const state = yield* serverExposure.getState;
        assert.equal(state.mode, "local-only");
        assert.equal(state.endpointUrl, null);
      }),
    ),
  );

  it.effect("honors a preferred LAN interface", () =>
    withHarness(
      multiHomedNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setServerExposureMode("network-accessible");
        yield* serverExposure.configureFromSettings({ port: 4173 });
        const change = yield* serverExposure.setPreferredLanInterfaceName({ name: "en1" });

        assert.equal(change.state.advertisedHost, "192.168.1.21");
        assert.equal(change.state.preferredLanInterfaceName, "en1");
        assert.equal(change.requiresRelaunch, false);

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        const defaultEndpoint = endpoints.find(
          (endpoint) => endpoint.id.startsWith("desktop-lan:") && endpoint.isDefault === true,
        );
        assert.equal(defaultEndpoint?.httpBaseUrl, "http://192.168.1.21:4173/");
      }),
    ),
  );

  it.effect("falls back to automatic when the preferred interface disappears", () =>
    withHarness(
      multiHomedNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setServerExposureMode("network-accessible");
        yield* serverExposure.configureFromSettings({ port: 4173 });
        const change = yield* serverExposure.setPreferredLanInterfaceName({ name: "en9" });

        assert.equal(change.state.preferredLanInterfaceName, "en9");
        assert.equal(change.state.advertisedHost, "192.168.1.20");
      }),
    ),
  );

  it.effect("persists tailscale serve preferences atomically and reports no-op updates", () =>
    withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.load;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const changed = yield* serverExposure.setTailscaleServeEnabled({
          enabled: true,
          port: 8443,
        });
        assert.equal(changed.requiresRelaunch, true);
        assert.equal(changed.state.tailscaleServeEnabled, true);
        assert.equal(changed.state.tailscaleServePort, 8443);

        const unchanged = yield* serverExposure.setTailscaleServeEnabled({
          enabled: true,
          port: 8443,
        });
        assert.equal(unchanged.requiresRelaunch, false);

        const persisted = yield* settings.get;
        assert.equal(persisted.tailscaleServeEnabled, true);
        assert.equal(persisted.tailscaleServePort, 8443);
      }),
    ),
  );

  it.effect("preserves persistence request context and the settings failure chain", () => {
    const diskFailure = new Error("disk exploded");
    const settingsFailure = new DesktopAppSettings.DesktopSettingsWriteError({
      operation: "replace-settings-file",
      path: "/tmp/desktop-settings.json",
      cause: diskFailure,
    });
    const layerSettings = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
      get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
      load: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
      setMainWindowBounds: () => Effect.die("unexpected main window bounds update"),
      setServerExposureMode: () => Effect.fail(settingsFailure),
      setPreferredLanInterfaceName: () => Effect.fail(settingsFailure),
      setTailscaleServe: () => Effect.fail(settingsFailure),
      setUpdateChannel: () => Effect.die("unexpected update channel change"),
      setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
      setWslDistro: () => Effect.die("unexpected WSL distro change"),
      setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
      setLocalEnvironmentEnabled: () => Effect.die("unexpected local environment toggle"),
      applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
      applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
    } satisfies DesktopAppSettings.DesktopAppSettings["Service"]);

    return withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const modeError = yield* serverExposure.setMode("network-accessible").pipe(Effect.flip);
        assert.instanceOf(
          modeError,
          DesktopServerExposure.DesktopServerExposureModePersistenceError,
        );
        assert.equal(modeError.mode, "network-accessible");
        assert.strictEqual(modeError.cause, settingsFailure);
        assert.strictEqual(modeError.cause.cause, diskFailure);
        assert.equal(
          modeError.message,
          "Failed to persist desktop server exposure mode network-accessible.",
        );
        assert.notInclude(modeError.message, diskFailure.message);

        const tailscaleError = yield* serverExposure
          .setTailscaleServeEnabled({ enabled: true, port: 8443 })
          .pipe(Effect.flip);
        assert.instanceOf(
          tailscaleError,
          DesktopServerExposure.DesktopTailscaleServePersistenceError,
        );
        assert.equal(tailscaleError.enabled, true);
        assert.equal(tailscaleError.port, 8443);
        assert.strictEqual(tailscaleError.cause, settingsFailure);
        assert.strictEqual(tailscaleError.cause.cause, diskFailure);
        assert.equal(
          tailscaleError.message,
          "Failed to persist desktop Tailscale Serve settings (enabled: true, port: 8443).",
        );
        assert.notInclude(tailscaleError.message, diskFailure.message);
      }),
      {},
      undefined,
      layerSettings,
    );
  });
  it.effect("keeps a Tailscale Serve change made while a mode change is saving", () =>
    Effect.gen(function* () {
      const modeWriteStarted = yield* Deferred.make<void>();
      const releaseModeWrite = yield* Deferred.make<void>();
      const settingsLayer = Layer.effect(
        DesktopAppSettings.DesktopAppSettings,
        Effect.gen(function* () {
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          return DesktopAppSettings.DesktopAppSettings.of({
            ...settings,
            setServerExposureMode: (mode) =>
              Deferred.succeed(modeWriteStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseModeWrite)),
                Effect.andThen(settings.setServerExposureMode(mode)),
              ),
          });
        }),
      ).pipe(Layer.provide(DesktopAppSettings.layerTest()));

      return yield* withHarness(
        lanNetworkInterfaces,
        Effect.gen(function* () {
          const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
          yield* serverExposure.configureFromSettings({ port: 4173 });

          const modeChange = yield* serverExposure
            .setMode("network-accessible")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(modeWriteStarted);
          const tailscaleChange = yield* serverExposure
            .setTailscaleServeEnabled({ enabled: true, port: 8443 })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.succeed(releaseModeWrite, undefined);
          yield* Fiber.join(modeChange);
          yield* Fiber.join(tailscaleChange);

          const state = yield* serverExposure.getState;
          assert.equal(state.mode, "network-accessible");
          assert.equal(state.tailscaleServeEnabled, true);
          assert.equal(state.tailscaleServePort, 8443);
        }),
        {},
        undefined,
        settingsLayer,
      );
    }),
  );

  it.effect("keeps LAN and Tailscale endpoints distinct when Tailscale is enumerated first", () =>
    withHarness(
      { ...tailnetNetworkInterfaces, ...lanNetworkInterfaces },
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        yield* serverExposure.setMode("network-accessible");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/", "http://192.168.1.20:4173/", "http://100.90.1.2:4173/"],
        );
      }),
    ),
  );

  it.effect("keeps Tailscale-only hosts network-accessible", () =>
    withHarness(
      tailnetNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setServerExposureMode("network-accessible");

        const state = yield* serverExposure.configureFromSettings({ port: 4173 });
        assert.equal(state.mode, "network-accessible");
        assert.equal(state.advertisedHost, null);
        assert.equal(state.endpointUrl, null);
        assert.equal((yield* serverExposure.backendConfig).bindHost, "0.0.0.0");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => [endpoint.reachability, endpoint.httpBaseUrl]),
          [
            ["loopback", "http://127.0.0.1:4173/"],
            ["private-network", "http://100.90.1.2:4173/"],
          ],
        );
      }),
    ),
  );

  it.effect(
    "refreshes Tailscale status when addresses change and caches unchanged addresses",
    () => {
      const networkInterfaces: Record<
        string,
        readonly DesktopNetworkInterfaces.DesktopNetworkInterfaceInfo[] | undefined
      > = { ...lanNetworkInterfaces };
      let statusJson = "{}";
      let statusReads = 0;

      return withHarness(
        networkInterfaces,
        Effect.gen(function* () {
          const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
          yield* serverExposure.configureFromSettings({ port: 4173 });
          yield* serverExposure.setMode("network-accessible");

          const initial = yield* serverExposure.getAdvertisedEndpoints;
          assert.deepEqual(
            initial.map((endpoint) => endpoint.httpBaseUrl),
            ["http://127.0.0.1:4173/", "http://192.168.1.20:4173/"],
          );
          assert.equal(statusReads, 1);

          for (const [address, dnsName] of [
            ["100.90.1.2", "desktop.tail.ts.net"],
            ["100.90.1.3", "desktop.other-tail.ts.net"],
          ] as const) {
            networkInterfaces.vpn0 = [{ address, family: "IPv4", internal: false }];
            statusJson = JSON.stringify({
              Self: { DNSName: `${dnsName}.`, TailscaleIPs: [address] },
            });
            const previousReads = statusReads;

            const endpoints = yield* serverExposure.getAdvertisedEndpoints;
            assert.deepEqual(
              endpoints.map((endpoint) => endpoint.httpBaseUrl),
              [
                "http://127.0.0.1:4173/",
                "http://192.168.1.20:4173/",
                `http://${address}:4173/`,
                `https://${dnsName}/`,
              ],
            );
            assert.equal(statusReads, previousReads + 1);
            assert.deepEqual(yield* serverExposure.getAdvertisedEndpoints, endpoints);
            assert.equal(statusReads, previousReads + 1);
          }
        }),
        {},
        layerMockSpawner(
          () => statusJson,
          () => {
            statusReads += 1;
          },
        ),
      );
    },
  );

  it.effect("preserves explicit Tailscale exposure overrides", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        const change = yield* serverExposure.setMode("network-accessible");

        assert.equal(change.state.advertisedHost, "100.90.1.2");
        assert.equal(change.state.endpointUrl, "http://100.90.1.2:4173");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/", "http://100.90.1.2:4173/", "https://public.example.test/"],
        );
      }),
      {
        T3CODE_DESKTOP_LAN_HOST: "100.90.1.2",
        T3CODE_DESKTOP_HTTPS_ENDPOINTS: "https://public.example.test",
      },
    ),
  );
  it.effect("advertises loopback, LAN, and configured manual endpoints from runtime state", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 3773 });
        yield* serverExposure.setMode("network-accessible");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(endpoints, [
          {
            id: "desktop-loopback:3773",
            label: "This machine",
            provider: {
              id: "desktop-core",
              label: "Desktop",
              kind: "core",
              isAddon: false,
            },
            httpBaseUrl: "http://127.0.0.1:3773/",
            wsBaseUrl: "ws://127.0.0.1:3773/",
            reachability: "loopback",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "desktop-core",
            status: "available",
            description: "Loopback endpoint for this desktop app.",
          },
          {
            id: "desktop-lan:http://192.168.1.20:3773",
            label: "Local network",
            interfaceName: "en0",
            provider: {
              id: "desktop-core",
              label: "Desktop",
              kind: "core",
              isAddon: false,
            },
            httpBaseUrl: "http://192.168.1.20:3773/",
            wsBaseUrl: "ws://192.168.1.20:3773/",
            reachability: "lan",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "desktop-core",
            status: "available",
            isDefault: true,
            description: "Reachable from devices on the same network.",
          },
          {
            id: "manual:https://desktop.example.ts.net",
            label: "Custom HTTPS",
            provider: {
              id: "manual",
              label: "Manual",
              kind: "manual",
              isAddon: false,
            },
            httpBaseUrl: "https://desktop.example.ts.net/",
            wsBaseUrl: "wss://desktop.example.ts.net/",
            reachability: "public",
            compatibility: {
              hostedHttpsApp: "compatible",
              desktopApp: "compatible",
            },
            source: "user",
            status: "unknown",
            description: "User-configured HTTPS endpoint for this desktop backend.",
          },
          {
            id: "manual:http://desktop.example.test:3773",
            label: "Custom endpoint",
            provider: {
              id: "manual",
              label: "Manual",
              kind: "manual",
              isAddon: false,
            },
            httpBaseUrl: "http://desktop.example.test:3773/",
            wsBaseUrl: "ws://desktop.example.test:3773/",
            reachability: "public",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "user",
            status: "unknown",
            description: "User-configured endpoint for this desktop backend.",
          },
        ]);
      }),
      {
        T3CODE_DESKTOP_HTTPS_ENDPOINTS:
          "https://desktop.example.ts.net,http://desktop.example.test:3773,not-a-url",
      },
    ),
  );
});
