import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAuth } from "@clerk/expo";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Notifications from "expo-notifications";
import { useNavigation } from "@react-navigation/native";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AppState, Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import {
  openAndroidLiveUpdateSettings,
  supportsAndroidLiveUpdateSettings,
} from "../agent-awareness/androidNotifications";
import { setLiveActivityUpdatesEnabled } from "../agent-awareness/liveActivityPreferences";
import {
  enableLocalAgentNotifications,
  disableLocalAgentNotifications,
  setLocalAgentOngoing,
} from "../agent-awareness/localNotifications";
import { loadOrCreateAgentAwarenessDeviceId, loadPreferences } from "../../persistence/imperative";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import {
  getAgentAwarenessRegistrationStatus,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
} from "../agent-awareness/remoteRegistration";
import { refreshManagedRelayEnvironments } from "../cloud/managedRelayState";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { resolveAgentAwarenessPlatformPresentation } from "./SettingsRouteScreen.logic";

type NotificationStatus = "checking" | "enabled" | "disabled" | "unsupported";
type LiveActivityStatus = "checking" | "enabled" | "disabled" | "signed-out" | "linking";

// Reflects whether the relay actually accepted this device's registration.
// The notification and Live Activity switches are gated on this so they can
// never read as enabled when the device cannot receive anything (e.g. the
// registration request timed out).
function useDeviceRegistered(): boolean {
  const status = useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    getAgentAwarenessRegistrationStatus,
    () => "unknown" as const,
  );
  return status === "registered";
}

export function SettingsNotificationsRouteScreen() {
  if (!hasCloudPublicConfig()) {
    if (Platform.OS === "android") return <LocalAndroidNotificationsSettings />;
    return (
      <SettingsScreen title="Notifications">
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pt-4"
        >
          <Text className="text-base text-foreground-muted">
            Notifications require T3 Connect in this app build.
          </Text>
        </ScrollView>
      </SettingsScreen>
    );
  }

  return <ConfiguredSettingsNotificationsRouteScreen />;
}

function LocalSenderConfigurationRow({ enabled }: { readonly enabled: boolean }) {
  return (
    <SettingsRow
      icon="doc.on.doc"
      label="Copy local sender configuration"
      disabled={!enabled}
      onPress={() => {
        void (async () => {
          const deviceId = await loadOrCreateAgentAwarenessDeviceId();
          const token = (await Notifications.getDevicePushTokenAsync()).data;
          const copied = await tryCopyTextWithHaptic(
            JSON.stringify({ token, deviceId, userId: `local:${deviceId}` }, null, 2),
          );
          if (!copied) Alert.alert("Could not copy", "Try again.");
          else Alert.alert("Copied", "Sender configuration copied. Keep the push token private.");
        })().catch(() =>
          Alert.alert("Could not get push token", "Enable notifications and try again."),
        );
      }}
    />
  );
}

function LocalAndroidNotificationsSettings() {
  const [enabled, setEnabled] = useState(false);
  const [ongoing, setOngoing] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const preferences = await loadPreferences();
    setEnabled(preferences.localNotificationsEnabled === true);
    setOngoing(preferences.localNotificationsOngoing === true);
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  const enable = useCallback(async (withOngoing = false) => {
    setBusy(true);
    try {
      const permission = await runtime.runPromiseExit(requestAgentNotificationPermission);
      if (permission._tag !== "Success" || permission.value.type !== "granted") {
        Alert.alert("Notifications unavailable", "Notification permission is required.");
        return;
      }
      await enableLocalAgentNotifications(withOngoing);
      setEnabled(true);
      setOngoing(withOngoing);
    } catch {
      Alert.alert("Notifications unavailable", "Could not enable local notifications.");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <SettingsScreen title="Notifications">
      <ScrollView contentContainerClassName="gap-6 px-5 pt-4">
        <SettingsSection title="Device-local Android notifications">
          <SettingsSwitchRow
            icon="bell.badge"
            label="Device Notifications"
            value={enabled}
            disabled={busy}
            onValueChange={(value) => {
              if (value) void enable(ongoing);
              else
                void disableLocalAgentNotifications()
                  .then(() => {
                    setEnabled(false);
                    setOngoing(false);
                  })
                  .catch(() =>
                    Alert.alert("Notifications unavailable", "Could not save the setting."),
                  );
            }}
          />
          <SettingsSwitchRow
            icon="bolt.circle"
            label="Ongoing Agent Activity"
            value={ongoing}
            disabled={!enabled || busy}
            onValueChange={(value) => {
              void setLocalAgentOngoing(value)
                .then(() => setOngoing(value))
                .catch(() =>
                  Alert.alert("Notifications unavailable", "Could not update ongoing activity."),
                );
            }}
          />
          <Text className="text-base text-foreground-muted">
            No T3 Connect account or relay is used. Delivery requires a separate sender configured
            with this app's Firebase project.
          </Text>
          <LocalSenderConfigurationRow enabled={enabled} />
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}

function ConfiguredSettingsNotificationsRouteScreen() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const agentAwarenessPushAvailable = supportsAgentAwarenessPush();
  const agentAwarenessPlatform = resolveAgentAwarenessPlatformPresentation(Platform.OS);
  const agentAwarenessSubtitle =
    Platform.OS === "android" && !agentAwarenessPushAvailable
      ? "Install a newer app build to enable notifications"
      : agentAwarenessPlatform.subtitle;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>("checking");
  const [liveActivityStatus, setLiveActivityStatus] = useState<LiveActivityStatus>("checking");
  const [localNotificationsEnabled, setLocalNotificationsEnabled] = useState(false);
  const [localOngoingEnabled, setLocalOngoingEnabled] = useState(false);
  const liveActivityWriteInFlight = useRef(false);
  const deviceRegistered = useDeviceRegistered();
  const liveActivitiesPreferenceEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.liveActivitiesEnabled !== false
    : true;
  const canClearLiveActivitiesPreference =
    AsyncResult.isSuccess(preferencesResult) &&
    preferencesResult.value.liveActivitiesEnabled !== false;

  const connections = useMemo(() => Object.values(savedConnectionsById), [savedConnectionsById]);
  const environmentCount = connections.length;

  const refreshNotifications = useCallback(async () => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      setNotificationStatus("unsupported");
      return;
    }
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, { label: "notification permission refresh" });
      setNotificationStatus("disabled");
      return;
    }
    setNotificationStatus(result.value.granted ? "enabled" : "disabled");
  }, []);

  useEffect(() => {
    if (Platform.OS === "android" && !isSignedIn) {
      void loadPreferences()
        .then((preferences) => {
          setLocalNotificationsEnabled(preferences.localNotificationsEnabled === true);
          setLocalOngoingEnabled(preferences.localNotificationsOngoing === true);
        })
        .catch(() => setLocalNotificationsEnabled(false));
    } else {
      setLocalNotificationsEnabled(false);
      setLocalOngoingEnabled(false);
    }
  }, [isSignedIn]);

  useEffect(() => {
    void refreshNotifications();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshNotifications();
    });
    return () => subscription.remove();
  }, [refreshNotifications]);

  useEffect(() => {
    if (!isLoaded) {
      setLiveActivityStatus("checking");
      return;
    }
    if (!isSignedIn) {
      setLiveActivityStatus(localOngoingEnabled ? "enabled" : "signed-out");
      return;
    }
    if (!AsyncResult.isSuccess(preferencesResult)) {
      if (AsyncResult.isFailure(preferencesResult)) {
        reportAtomCommandResult(preferencesResult, { label: "live activity preference load" });
        setLiveActivityStatus("enabled");
      } else {
        setLiveActivityStatus("checking");
      }
      return;
    }
    setLiveActivityStatus(
      preferencesResult.value.liveActivitiesEnabled === false ? "disabled" : "enabled",
    );
  }, [isLoaded, isSignedIn, localOngoingEnabled, preferencesResult]);

  const requestNotifications = useCallback(async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        requestAgentNotificationPermission.pipe(
          Effect.tap((permission) =>
            permission.type === "granted" ? refreshAgentAwarenessRegistration() : Effect.void,
          ),
        ),
      ),
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Notifications unavailable",
          error instanceof Error ? error.message : "Could not request notification permission.",
        );
      }
      return;
    }
    if (result.value.type === "granted") {
      setNotificationStatus("enabled");
      // Permission alone is not enough: the switch stays off until the relay
      // registration succeeds, so tell the user the truth about which happened.
      if (getAgentAwarenessRegistrationStatus() === "registered") {
        Alert.alert("Notifications enabled", "Agent notifications are enabled for this device.");
      } else {
        Alert.alert(
          "Couldn't finish enabling notifications",
          "Notification access was granted, but this device could not be registered with T3 Connect. Notifications will start once registration succeeds.",
        );
      }
      return;
    }
    if (result.value.type === "unsupported") {
      setNotificationStatus("unsupported");
      Alert.alert(
        "Notifications unavailable",
        "Agent notifications are unavailable on this platform.",
      );
      return;
    }
    setNotificationStatus("disabled");
    if (result.value.canAskAgain) {
      Alert.alert("Notifications disabled", "Notifications were not enabled.");
      return;
    }
    Alert.alert(
      "Notifications disabled",
      "Notifications were denied for this app. Open Settings to enable them.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  }, []);

  const promptSignIn = useCallback(() => {
    Alert.alert(
      "Sign in to T3 Connect",
      "Live Activity updates require T3 Connect so relay can deliver updates to this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          onPress: () => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" }),
        },
      ],
    );
  }, [navigation]);

  const linkEnvironments = useCallback(async () => {
    if (!isSignedIn) {
      promptSignIn();
      return;
    }

    setLiveActivityStatus("linking");
    if (Platform.OS === "android") {
      const permission = await settleAsyncResult(() =>
        runtime.runPromiseExit(requestAgentNotificationPermission),
      );
      if (permission._tag === "Failure") {
        setLiveActivityStatus("disabled");
        const error = squashAtomCommandFailure(permission);
        Alert.alert(
          "Ongoing activity unavailable",
          error instanceof Error ? error.message : "Could not enable agent notifications.",
        );
        return;
      }
      if (permission.value.type !== "granted") {
        setLiveActivityStatus("disabled");
        Alert.alert(
          "Notification permission needed",
          "Enable notifications in system Settings to show ongoing agent activity.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Settings", onPress: () => void Linking.openSettings() },
          ],
        );
        return;
      }
      setNotificationStatus("enabled");
    }
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    if (tokenResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      const error = squashAtomCommandFailure(tokenResult);
      Alert.alert(
        Platform.OS === "android" ? "Ongoing activity unavailable" : "Live Activities unavailable",
        error instanceof Error ? error.message : "Could not enable agent activity updates.",
      );
      return;
    }
    if (!tokenResult.value) {
      promptSignIn();
      setLiveActivityStatus("signed-out");
      return;
    }

    const updateResult = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          enabled: true,
          previousEnabled: liveActivitiesPreferenceEnabled,
          clerkToken: tokenResult.value,
          connections,
        }),
      ),
    );
    if (updateResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      if (!isAtomCommandInterrupted(updateResult)) {
        const error = squashAtomCommandFailure(updateResult);
        Alert.alert(
          Platform.OS === "android"
            ? "Ongoing activity unavailable"
            : "Live Activities unavailable",
          error instanceof Error ? error.message : "Could not enable agent activity updates.",
        );
      }
      return;
    }

    savePreferences({ liveActivitiesEnabled: true });
    refreshManagedRelayEnvironments();
    setLiveActivityStatus("enabled");
    // The environment link can succeed while this device's own registration
    // (the push-to-start token the relay needs) has not — don't claim Live
    // Activities are live until the device is actually registered.
    if (getAgentAwarenessRegistrationStatus() === "registered") {
      Alert.alert(
        Platform.OS === "android" ? "Ongoing activity enabled" : "Live Activities enabled",
        environmentCount > 0
          ? `${environmentCount} environment${environmentCount === 1 ? "" : "s"} linked for agent activity updates.`
          : "Agent activity updates are enabled. Add an environment to start receiving updates.",
      );
    } else {
      Alert.alert(
        "Couldn't finish enabling activity updates",
        "This device could not be registered with T3 Connect, so activity updates won't appear yet. They'll start once registration succeeds.",
      );
    }
  }, [
    connections,
    environmentCount,
    getToken,
    isSignedIn,
    liveActivitiesPreferenceEnabled,
    promptSignIn,
    savePreferences,
  ]);

  const handleDeviceNotificationsChange = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        if (!isSignedIn && Platform.OS === "android") {
          void (async () => {
            const permission = await settleAsyncResult(() =>
              runtime.runPromiseExit(requestAgentNotificationPermission),
            );
            if (permission._tag !== "Success" || permission.value.type !== "granted") {
              Alert.alert("Notifications unavailable", "Notification permission is required.");
              return;
            }
            await enableLocalAgentNotifications(false);
            setLocalNotificationsEnabled(true);
            setNotificationStatus("enabled");
            Alert.alert(
              "Notifications enabled",
              "Local notifications are enabled. A local Firebase sender is required for delivery.",
            );
          })().catch(() =>
            Alert.alert("Notifications unavailable", "Could not enable local notifications."),
          );
          return;
        }
        if (!isSignedIn) {
          promptSignIn();
          return;
        }
        void requestNotifications();
        return;
      }

      if (!isSignedIn && Platform.OS === "android") {
        void disableLocalAgentNotifications().catch(() => {
          Alert.alert("Notifications unavailable", "Could not save the notification setting.");
        });
        setLocalNotificationsEnabled(false);
        setLocalOngoingEnabled(false);
        return;
      }
      Alert.alert(
        "Disable notifications",
        "Open system Settings to disable notifications for T3 Code.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: () => void Linking.openSettings() },
        ],
      );
    },
    [isSignedIn, promptSignIn, requestNotifications],
  );

  const handleLiveActivitiesChange = useCallback(
    (enabled: boolean) => {
      if (liveActivityWriteInFlight.current) return;
      if (!isSignedIn && Platform.OS === "android") {
        if (!localNotificationsEnabled && enabled) {
          Alert.alert(
            "Enable notifications first",
            "Turn on Device Notifications before enabling ongoing activity.",
          );
          return;
        }
        void setLocalAgentOngoing(enabled)
          .then(() => {
            setLocalOngoingEnabled(enabled);
            setLiveActivityStatus(enabled ? "enabled" : "disabled");
          })
          .catch(() =>
            Alert.alert("Ongoing activity unavailable", "Could not update local ongoing activity."),
          );
        return;
      }
      if (!enabled) {
        liveActivityWriteInFlight.current = true;
        setLiveActivityStatus("linking");
        void (async () => {
          try {
            let token: string | null = null;
            if (isSignedIn) {
              const tokenResult = await settlePromise(() =>
                getToken(resolveRelayClerkTokenOptions()),
              );
              if (tokenResult._tag === "Failure") {
                setLiveActivityStatus("enabled");
                reportAtomCommandResult(tokenResult, {
                  label: "live activity disable token lookup",
                });
                return;
              }
              token = tokenResult.value;
            }

            const updateResult = await settleAsyncResult(() =>
              runtime.runPromiseExit(
                setLiveActivityUpdatesEnabled({
                  enabled: false,
                  previousEnabled: liveActivitiesPreferenceEnabled,
                  clerkToken: token,
                  connections,
                }),
              ),
            );
            if (updateResult._tag === "Failure") {
              setLiveActivityStatus(isSignedIn ? "enabled" : "signed-out");
              reportAtomCommandResult(updateResult, {
                label: "live activity disable",
              });
              return;
            }
            savePreferences({ liveActivitiesEnabled: false });
            refreshManagedRelayEnvironments();
            setLiveActivityStatus("disabled");
          } finally {
            liveActivityWriteInFlight.current = false;
          }
        })();
        return;
      }

      if (!isSignedIn) {
        promptSignIn();
        return;
      }

      liveActivityWriteInFlight.current = true;
      void linkEnvironments().finally(() => {
        liveActivityWriteInFlight.current = false;
      });
    },
    [
      connections,
      getToken,
      isSignedIn,
      localNotificationsEnabled,
      linkEnvironments,
      liveActivitiesPreferenceEnabled,
      promptSignIn,
      savePreferences,
    ],
  );

  return (
    <SettingsScreen title="Notifications">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title="Agent activity">
          <SettingsSwitchRow
            icon="bell.badge"
            label="Device Notifications"
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              notificationStatus === "checking" ||
              notificationStatus === "unsupported"
            }
            subtitle={agentAwarenessSubtitle}
            // Only reads as on when this device is actually registered with the
            // relay; otherwise notifications cannot be delivered regardless of
            // the local iOS permission.
            value={
              agentAwarenessPushAvailable &&
              notificationStatus === "enabled" &&
              (deviceRegistered || localNotificationsEnabled)
            }
            onValueChange={handleDeviceNotificationsChange}
          />
          <SettingsSwitchRow
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              !isLoaded ||
              liveActivityStatus === "checking" ||
              liveActivityStatus === "linking"
            }
            icon="bolt.circle"
            label={
              Platform.OS === "android"
                ? supportsAndroidLiveUpdateSettings()
                  ? "Agent Live Updates"
                  : "Ongoing Agent Activity"
                : "Live Activity Updates"
            }
            subtitle={agentAwarenessSubtitle}
            // Same gate: a saved preference is meaningless until the device
            // registration the relay needs to push updates has succeeded.
            value={
              agentAwarenessPushAvailable &&
              (liveActivityStatus === "enabled" || liveActivityStatus === "linking") &&
              (deviceRegistered || localOngoingEnabled)
            }
            onValueChange={handleLiveActivitiesChange}
          />
          {liveActivityStatus === "signed-out" && canClearLiveActivitiesPreference ? (
            <SettingsRow
              icon="bolt.circle"
              label="Turn off Live Activity preference"
              onPress={() => handleLiveActivitiesChange(false)}
            />
          ) : null}
          {!isSignedIn && Platform.OS === "android" ? (
            <LocalSenderConfigurationRow enabled={localNotificationsEnabled} />
          ) : null}
          {supportsAndroidLiveUpdateSettings() ? (
            <SettingsRow
              icon="bolt.circle"
              label="Live Update Settings"
              onPress={() => {
                void openAndroidLiveUpdateSettings().catch(() => {
                  Alert.alert(
                    "Couldn't open Settings",
                    "Open Android Settings, select T3 Code, then enable Live Updates in Notifications.",
                  );
                });
              }}
            />
          ) : null}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
