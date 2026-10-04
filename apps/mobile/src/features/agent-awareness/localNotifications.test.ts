import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  os: "android",
  preferences: { localNotificationsEnabled: false, localNotificationsOngoing: false } as Record<
    string,
    unknown
  >,
  deviceId: "device-1",
  configure: vi.fn(),
  clear: vi.fn(),
  save: vi.fn(),
  pushToken: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return mocks.os;
    },
  },
}));
vi.mock("expo-notifications", () => ({
  getDevicePushTokenAsync: mocks.pushToken,
}));
vi.mock("../../persistence/imperative", () => ({
  loadOrCreateAgentAwarenessDeviceId: vi.fn(async () => mocks.deviceId),
  loadPreferences: vi.fn(async () => mocks.preferences),
  savePreferencesPatch: mocks.save,
}));
vi.mock("./androidNotifications", () => ({
  configureAndroidAgentNotifications: mocks.configure,
  clearAndroidAgentNotifications: mocks.clear,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.os = "android";
  mocks.preferences = { localNotificationsEnabled: false, localNotificationsOngoing: false };
  mocks.configure.mockReset();
  mocks.clear.mockReset();
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.pushToken.mockReset().mockResolvedValue({ data: "token-secret" });
});

describe("local agent notifications", () => {
  it("persists explicit opt-in and returns setup identity without logging its token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { enableLocalAgentNotifications } = await import("./localNotifications");
    await expect(enableLocalAgentNotifications(true)).resolves.toEqual({
      deviceId: "device-1",
      userId: "local:device-1",
      pushToken: "token-secret",
    });
    expect(mocks.save).toHaveBeenCalledWith({
      localNotificationsEnabled: true,
      localNotificationsOngoing: true,
    });
    expect(mocks.configure).toHaveBeenCalledWith("device-1", "local:device-1", true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not restore based on OS permission alone when local opt-in is false", async () => {
    const { restoreLocalAgentNotifications } = await import("./localNotifications");
    await restoreLocalAgentNotifications();
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  it("does not turn notifications back on when disabling ongoing while local alerts are off", async () => {
    const { setLocalAgentOngoing } = await import("./localNotifications");
    await setLocalAgentOngoing(false);
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledWith({ localNotificationsOngoing: false });
  });

  it("clears both opt-ins when local notifications are disabled", async () => {
    const { disableLocalAgentNotifications } = await import("./localNotifications");
    await disableLocalAgentNotifications();
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith({
      localNotificationsEnabled: false,
      localNotificationsOngoing: false,
    });
  });

  it("restores only a persisted local opt-in", async () => {
    mocks.preferences.localNotificationsEnabled = true;
    mocks.preferences.localNotificationsOngoing = true;
    const { restoreLocalAgentNotifications } = await import("./localNotifications");
    await restoreLocalAgentNotifications();
    expect(mocks.configure).toHaveBeenCalledWith("device-1", "local:device-1", true);
  });
});
