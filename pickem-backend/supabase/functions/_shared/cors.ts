// supabase/functions/_shared/cors.ts
//
// Without these headers, a browser-based caller (like Snack's web preview,
// or any future web version of this app) gets blocked before the request
// even reaches this function — the browser sends a preflight OPTIONS
// request first, and if nothing answers it correctly, the real request
// never goes out at all. That's exactly what "Failed to fetch" means: the
// request died before getting a response, not an error the server sent.
//
// Native device requests (a real Expo Go app on a phone) aren't subject to
// CORS at all — only actual browser-based JS is — but adding this doesn't
// hurt native callers, so every client-callable function gets it.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Call this first thing in every client-callable function's handler. */
export function handleCorsPreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}
