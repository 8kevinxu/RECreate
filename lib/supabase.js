import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';

// Configure by setting these in your .env (EXPO_PUBLIC_* are inlined at build):
//   EXPO_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
//   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon public key>
// When unset, `supabase` is null and the app falls back to local check-ins.
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const supabase =
  url && anonKey
    ? createClient(url, anonKey, {
        // Anonymous, write-only check-ins — no auth session to persist.
        auth: { persistSession: false },
      })
    : null;
