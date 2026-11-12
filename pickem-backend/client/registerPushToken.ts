// client/registerPushToken.ts
//
// Call this once after login (and again if you want to be defensive about
// tokens changing). Requires `expo-notifications`:
//   npx expo install expo-notifications
//
// This registers the device for push and upserts the token into
// push_tokens — the RLS policy on that table only lets a user write their
// own rows, so this is safe to call directly from the client.

import * as Notifications from "expo-notifications";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
);

export async function registerForPushNotifications(): Promise<string | null> {
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") {
    return null; // user declined — the app should still work, just without reminders
  }

  const { data: token } = await Notifications.getExpoPushTokenAsync();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return token;

  const { error } = await supabase
    .from("push_tokens")
    .upsert({ user_id: user.id, token, updated_at: new Date().toISOString() }, { onConflict: "user_id,token" });

  if (error) {
    console.warn("registerForPushNotifications: failed to save token", error.message);
  }

  return token;
}
