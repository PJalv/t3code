import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import {
  loadOrCreateAgentAwarenessDeviceId,
  loadPreferences,
  savePreferencesPatch,
} from "../../persistence/imperative";
import {
  clearAndroidAgentNotifications,
  configureAndroidAgentNotifications,
} from "./androidNotifications";

export interface LocalAgentNotificationIdentity {
  readonly deviceId: string;
  readonly userId: string;
  readonly pushToken: string | null;
}

function localUserId(deviceId: string): string {
  return `local:${deviceId}`;
}

// Notifications normally require T3 Connect so the hosted relay can deliver to
// this device. Local mode skips the relay: the app configures the native
// Android handler with a device-local identity. A separately configured sender
// delivers through the same Firebase project.
//
// The choice is persisted because the cloud sign-out path clears the native
// handler on every launch while signed out; `restoreLocalAgentNotifications`
// re-applies it.
export async function enableLocalAgentNotifications(
  ongoingEnabled: boolean,
): Promise<LocalAgentNotificationIdentity | null> {
  if (Platform.OS !== "android") return null;
  const deviceId = await loadOrCreateAgentAwarenessDeviceId();
  const userId = localUserId(deviceId);
  configureAndroidAgentNotifications(deviceId, userId, ongoingEnabled);
  await savePreferencesPatch({
    localNotificationsEnabled: true,
    localNotificationsOngoing: ongoingEnabled,
  });
  let pushToken: string | null = null;
  try {
    pushToken = (await Notifications.getDevicePushTokenAsync()).data;
  } catch {
    pushToken = null;
  }
  // Identity is returned only to the explicit setup action; never log credentials.
  return { deviceId, userId, pushToken };
}

export async function disableLocalAgentNotifications(): Promise<void> {
  clearAndroidAgentNotifications();
  await savePreferencesPatch({
    localNotificationsEnabled: false,
    localNotificationsOngoing: false,
  });
}

export async function setLocalAgentOngoing(enabled: boolean): Promise<void> {
  const preferences = await loadPreferences();
  if (preferences.localNotificationsEnabled !== true) {
    await savePreferencesPatch({ localNotificationsOngoing: false });
    return;
  }
  const deviceId = await loadOrCreateAgentAwarenessDeviceId();
  configureAndroidAgentNotifications(deviceId, localUserId(deviceId), enabled);
  await savePreferencesPatch({ localNotificationsOngoing: enabled });
}

// Re-applies the native handler after the cloud sign-out path clears it. Safe
// to call on every launch and whenever the relay provider is unset.
//
// The persisted setting is explicit opt-in. OS permission alone must not
// silently re-enable a local notification setting the user deliberately disabled.
export async function restoreLocalAgentNotifications(): Promise<void> {
  if (Platform.OS !== "android") return;
  const preferences = await loadPreferences();
  if (preferences.localNotificationsEnabled !== true) return;
  const deviceId = await loadOrCreateAgentAwarenessDeviceId();
  configureAndroidAgentNotifications(
    deviceId,
    localUserId(deviceId),
    preferences.localNotificationsOngoing === true,
  );
}
