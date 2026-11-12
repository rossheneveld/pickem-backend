// supabase/functions/_shared/push.ts
//
// Sends push notifications via Expo's Push API (https://exp.host/--/api/v2/push/send).
// Expo's service then relays to APNs/FCM as appropriate — this file never
// talks to Apple or Google directly, which is the whole point of using
// Expo's push service instead of hand-rolling native push integration.
//
// Expo answers HTTP 200 even when it rejects individual messages — the real
// outcome of each one is a "ticket" in the response body. This file used to
// treat any 200 as "sent", which made every per-device failure invisible:
// the job reported success and nothing arrived. Tickets are now read,
// failures are returned and logged, and tokens Expo says are dead are
// cleaned up so they stop being retried forever.
//
// A ticket only says whether Expo ACCEPTED a message. Problems further
// downstream (Apple/Google refusing it, missing or invalid FCM/APNs
// credentials) surface later in push RECEIPTS, which this file does not
// fetch — see https://docs.expo.dev/push-notifications/sending-notifications/

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const BATCH_SIZE = 100; // Expo's documented recommended max per request

function maskToken(token: string): string {
  return token.length > 24 ? `${token.slice(0, 24)}…` : token;
}

/**
 * Sends a push notification to every registered device for the given users.
 * Looks up tokens itself — callers just pass user IDs, not tokens.
 *
 * Returns how many devices Expo accepted (`sent`), how many it tried
 * (`attempted`), and a readable line for every failure (`errors`).
 */
export async function sendPushToUsers(
  admin: any, // a Supabase client created with the service_role key
  userIds: string[],
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<{ sent: number; attempted: number; errors: string[] }> {
  if (userIds.length === 0) return { sent: 0, attempted: 0, errors: [] };

  const { data: tokenRows, error } = await admin.from("push_tokens").select("token").in("user_id", userIds);
  if (error) return { sent: 0, attempted: 0, errors: [error.message] };

  const tokens = [...new Set((tokenRows ?? []).map((t: any) => t.token as string))];
  if (tokens.length === 0) return { sent: 0, attempted: 0, errors: [] };

  const messages = tokens.map((token) => ({
    to: token,
    title,
    body,
    data: data ?? {},
    sound: "default",
    // Android holds "normal"-priority messages back while a phone is idle
    // (Doze) — fine for a recap, wrong for "this game locks soon".
    priority: "high",
  }));

  const errors: string[] = [];
  const deadTokens: string[] = [];
  let sent = 0;

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(batch),
      });
      const json = await res.json();
      if (!res.ok) {
        errors.push(`batch starting at ${i}: HTTP ${res.status} ${JSON.stringify(json)}`);
        continue;
      }

      const tickets: any[] = Array.isArray(json?.data) ? json.data : [];
      if (tickets.length !== batch.length) {
        errors.push(`batch starting at ${i}: expected ${batch.length} tickets, got ${tickets.length}`);
      }
      tickets.forEach((ticket, idx) => {
        if (ticket?.status === "ok") {
          sent += 1;
          return;
        }
        const code = ticket?.details?.error ?? "unknown";
        const token = batch[idx]?.to as string;
        errors.push(`${maskToken(token)}: ${code} — ${ticket?.message ?? "no message"}`);
        if (code === "DeviceNotRegistered") deadTokens.push(token);
      });
    } catch (err) {
      errors.push(`batch starting at ${i}: ${String(err)}`);
    }
  }

  if (deadTokens.length > 0) {
    const { error: cleanupError } = await admin.from("push_tokens").delete().in("token", deadTokens);
    if (cleanupError) errors.push(`removing dead tokens failed: ${cleanupError.message}`);
  }

  if (errors.length > 0) console.error(`[push] "${title}": ${sent}/${tokens.length} accepted`, errors);

  return { sent, attempted: tokens.length, errors };
}