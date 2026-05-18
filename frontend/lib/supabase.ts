import { createClient } from "@supabase/supabase-js";

// NEXT_PUBLIC_* vars are baked in at build time by Next.js.
// The fallbacks prevent createClient from throwing during the SSG pre-render
// pass at build time (when env vars are not yet available in the Node process).
// In a real deployment the Cloudflare build always has the real values set,
// so the fallbacks are never reached at runtime.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

export const supabase = createClient(url, key);
