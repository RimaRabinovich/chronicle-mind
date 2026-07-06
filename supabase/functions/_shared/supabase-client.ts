import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Returns a Supabase client with the service role key.
 * Only used inside Edge Functions — never expose this key to the browser.
 */
export function getServiceClient() {
  const url  = Deno.env.get('SUPABASE_URL')!;
  const key  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
