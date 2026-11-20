import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    environments: [] as ReturnType<typeof environment>[],
    readOnly: new Set<string>(),
    navigate: (
      _name: string,
      _params: { environmentId: EnvironmentId; kind: SourceControlProviderKind },
    ) => {},
    command: vi.fn(),
    copy: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  Platform: { OS: "ios" },
  Linking: {},
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
  }) => (
    <button onClick={onPress} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
  TextInput: ({
    value,
    onChangeText,
    editable,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    editable: boolean;
    accessibilityLabel: string;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      disabled={!editable}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (environmentId: string) => !mocks.readOnly.has(environmentId),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: () =>
    new Set(
      mocks.environments
        .filter((entry) => !mocks.readOnly.has(entry.environmentId))
        .map((entry) => entry.environmentId),
    ),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateSettings: { commandName: "updateSettings", permissionAtom: (id: string) => id },
  },
}));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: Object.fromEntries(
    [
      "discovery",
      "gerritConnections",
      "gerritSigningPassphrase",
      "gerritConfigure",
      "gerritTest",
      "gerritRemove",
      "gerritRemoveCredentials",
      "gerritSetSigningPassphrase",
    ].map((name) => [
      name,
      Object.assign((target: { environmentId: string }) => ({ name, ...target }), {
        commandName: name,
        permissionAtom: (id: string) => id,
      }),
    ]),
  ),
}));
vi.mock("../../state/issueTrackers", () => ({ issueTrackerEnvironment: {} }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: ({ name, environmentId }: { name: string; environmentId: string }) => ({
    isSuccess: true,
    isPending: false,
    refresh: () => {},
    data:
      name === "discovery"
        ? {
            sourceControlProviders: [
              {
                kind: "gerrit",
                label: "Gerrit",
                version: Option.none(),
                status: "available",
                executable: null,
                installHint: { _tag: "none" },
                auth: { status: "authenticated", account: Option.none(), detail: Option.none() },
              },
            ],
          }
        : name === "gerritConnections"
          ? [
              {
                config: {
                  installation: `https://${environmentId}.example/Review/`,
                  authMode: "http-basic",
                  bindings: [],
                  sshHost: { host: `${environmentId}.example`, username: "reviewer", port: 29418 },
                },
                credentialPresent: true,
              },
            ]
          : { present: false },
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { commandName: string }) => (input: unknown) =>
    mocks.command(command.commandName, input),
}));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: mocks.copy }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("../../components/ui/SecretTextInput", () => ({ SecretTextInput: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../connection/ConnectionStatusDot", () => ({ ConnectionStatusDot: () => null }));
vi.mock("../connection/ConnectionFormField", () => ({ ConnectionFormField: () => null }));
vi.mock("../projects/SourceControlIcon", () => ({ SourceControlIcon: () => null }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/IssueTrackerSection", () => ({
  IssueTrackerCredentialForm: () => null,
  IssueTrackerProjectRows: () => null,
}));
vi.mock("./components/SourceControlSignInSection", () => ({ AppSignInRow: () => null }));

import { SourceControlProvidersSection } from "./components/SourceControlProvidersSection";
import { SettingsSourceControlProviderRouteScreen } from "./SettingsSourceControlDetailRouteScreens";
import type { SettingsTarget } from "./settings-environment-filter";

function environment(id: string) {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: { phase: "connected" },
    serverConfig: {
      settings: DEFAULT_SERVER_SETTINGS,
      environment: { capabilities: { gerrit: true } },
    },
  };
}

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.environments = [environment("local"), environment("remote")];
  mocks.readOnly = new Set();
  mocks.command.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  mocks.copy.mockReset().mockResolvedValue(true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const button = (label: string) => {
    const match = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label || item.getAttribute("aria-label") === label,
    );
    expect(match, `button ${label}`).toBeDefined();
    return match!;
  };
  const input = (label: string) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const renderDetail = (id: string) =>
    act(() =>
      root.render(
        <SettingsSourceControlProviderRouteScreen
          route={{
            params: {
              environmentId: EnvironmentId.make(id),
              kind: SourceControlProviderKind.make("gerrit"),
            },
          }}
        />,
      ),
    );
  return {
    container,
    root,
    button,
    input,
    renderDetail,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it("opens the selected environment's native Gerrit form and keeps edits, removal and terminal copy on that environment", async () => {
  using screen = setup();
  mocks.navigate = (_name, params) =>
    screen.root.render(<SettingsSourceControlProviderRouteScreen route={{ params }} />);
  act(() =>
    screen.root.render(
      <SourceControlProvidersSection
        environments={[mocks.environments[1] as unknown as SettingsTarget]}
        canWrite={() => true}
      />,
    ),
  );
  act(() => screen.button("Manage Gerrit").click());
  act(() => screen.button("Edit connection").click());
  expect(screen.input("Gerrit server URL").value).toBe("https://remote.example/Review/");
  expect(screen.input("SSH username (optional)").value).toBe("reviewer");
  await act(async () => screen.button("Save connection").click());
  expect(mocks.command).toHaveBeenLastCalledWith("gerritConfigure", {
    environmentId: "remote",
    input: {
      config: {
        installation: "https://remote.example/Review/",
        authMode: "http-basic",
        bindings: [],
        sshHost: { host: "remote.example", port: 29418, username: "reviewer" },
      },
    },
  });
  await act(async () => screen.button("Copy command template").click());
  expect(mocks.copy.mock.calls[0]?.[0]).toContain("--environment-id 'remote'");
  await act(async () => screen.button("Remove connection").click());
  expect(mocks.command).toHaveBeenLastCalledWith("gerritRemove", {
    environmentId: "remote",
    input: { installation: "https://remote.example/Review/" },
  });
  expect(mocks.command.mock.calls.some(([name]) => name === "updateSettings")).toBe(false);
});

it("clears connection drafts when a detail route changes environment and hides disconnected targets", () => {
  using screen = setup();
  screen.renderDetail("remote");
  act(() => screen.button("Edit connection").click());
  expect(screen.input("Gerrit server URL").value).toBe("https://remote.example/Review/");
  screen.renderDetail("local");
  expect(screen.input("Gerrit server URL").value).toBe("");
  mocks.environments[1]!.serverConfig.environment.capabilities.gerrit = false;
  screen.renderDetail("remote");
  expect(screen.container.querySelector("input")).toBeNull();
  mocks.environments = [];
  screen.renderDetail("remote");
  expect(screen.container.querySelector("input")).toBeNull();
  expect(screen.container.textContent).toContain("Connect this environment");
});

it("keeps a remote read-only connection inspectable without allowing settings mutations", async () => {
  using screen = setup();
  mocks.readOnly.add("remote");
  screen.renderDetail("remote");
  for (const label of [
    "Edit connection",
    "Test connection",
    "Remove credentials",
    "Remove connection",
    "Save connection",
    "Save passphrase",
    "Clear passphrase",
  ]) {
    expect(screen.button(label).disabled).toBe(true);
    act(() => screen.button(label).click());
  }
  expect(screen.input("Gerrit server URL").disabled).toBe(true);
  await act(async () => screen.button("Copy command template").click());
  expect(mocks.copy).toHaveBeenCalledOnce();
  expect(mocks.command).not.toHaveBeenCalled();
});
