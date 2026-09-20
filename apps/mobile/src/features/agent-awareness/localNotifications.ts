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
// Android handler with a device-local identity, and a local sender (the
// `push:android:watch` script) delivers through the same Firebase project.
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
  // Diagnostics for local setup: the watcher's device.json needs these values.
  console.warn(
    `[t3-local-notify] deviceId=${deviceId} userId=${userId} pushToken=${pushToken ?? "null"}`,
  );
  return { deviceId, userId, pushToken };
}

export function disableLocalAgentNotifications(): void {
  clearAndroidAgentNotifications();
  void savePreferencesPatch({
    localNotificationsEnabled: false,
    localNotificationsOngoing: false,
  }).catch(() => {});
}

// Re-applies the native handler after the cloud sign-out path clears it. Safe
// to call on every launch and whenever the relay provider is unset.
//
// The stored preference is the primary signal, but a granted notification
// permission is also treated as opt-in: `clearAndroidAgentNotifications()` runs
// on every signed-out launch, so relying on the preference alone means a single
// missed write silently disables local delivery until the user toggles it back.
export async function restoreLocalAgentNotifications(): Promise<void> {
  if (Platform.OS !== "android") return;
  const preferences = await loadPreferences();
  let optedIn = preferences.localNotificationsEnabled === true;
  if (!optedIn) {
    try {
      optedIn = (await Notifications.getPermissionsAsync()).granted;
    } catch {
      optedIn = false;
    }
  }
  if (!optedIn) return;
  const deviceId = await loadOrCreateAgentAwarenessDeviceId();
  configureAndroidAgentNotifications(
    deviceId,
    localUserId(deviceId),
    preferences.localNotificationsOngoing === true,
  );
  console.warn(`[t3-local-notify] restored deviceId=${deviceId}`);
}
