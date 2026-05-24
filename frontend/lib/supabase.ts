import { createClient } from "@supabase/supabase-js";

// NEXT_PUBLIC_* vars are baked in at build time. In production (Cloudflare
// Pages) both values are always present. The empty-string fallbacks prevent
// createClient from receiving `undefined` during the static-export pre-render
// step when vars haven't been injected yet.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const supabase = createClient(url, key);