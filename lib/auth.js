// Account state for HoopMap, backed by Supabase Auth (email + password).
// Accounts are optional: when Supabase isn't configured (`supabase` is null),
// `enabled` is false and the app simply hides account/social features.
import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { unregisterPush } from './push';
import { tg } from './i18n';

const AuthContext = createContext(null);

// Disabled stub returned when no provider / no Supabase, so callers can use
// `useAuth()` unconditionally.
const DISABLED = {
  enabled: false,
  loading: false,
  session: null,
  user: null,
  profile: null,
  displayName: null,
  signUp: async () => ({ error: new Error(tg('err.notConfigured')) }),
  signIn: async () => ({ error: new Error(tg('err.notConfigured')) }),
  signOut: async () => {},
  updateProfile: async () => ({ error: new Error(tg('err.notConfigured')) }),
  deleteAccount: async () => ({ error: new Error(tg('err.notConfigured')) }),
};

// Profile columns the app reads/writes (see supabase/schema/03_profiles.sql).
const PROFILE_COLS = 'id, display_name, age, bio, neighborhood, favorite_sports';

export function AuthProvider({ children }) {
  const enabled = !!supabase;
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(enabled);

  // Restore any existing session, then track auth changes.
  useEffect(() => {
    if (!enabled) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, [enabled]);

  // Load the profile (display name) whenever the signed-in user changes.
  const userId = session?.user?.id ?? null;
  useEffect(() => {
    if (!enabled || !userId) {
      setProfile(null);
      return;
    }
    let alive = true;
    supabase
      .from('profiles')
      .select(PROFILE_COLS)
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (alive) setProfile(data ?? null);
      });
    return () => {
      alive = false;
    };
  }, [enabled, userId]);

  const signUp = async (email, password, displayName) => {
    // display_name is stored in user metadata; a DB trigger copies it into the
    // public.profiles row created on signup (see supabase/schema/03_profiles.sql).
    return supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName?.trim() || null } },
    });
  };

  const signIn = (email, password) =>
    supabase.auth.signInWithPassword({ email, password });

  const signOut = async () => {
    // Drop this device's push token first, while the session still authorizes
    // the delete; then end the session.
    await unregisterPush();
    await supabase.auth.signOut();
    setProfile(null);
  };

  // Upsert any subset of editable profile fields (display name, age, bio,
  // favorite sports). Empty strings are stored as null; values are trimmed.
  const updateProfile = async (fields) => {
    if (!userId) return { error: new Error(tg('err.notSignedIn')) };
    const patch = { id: userId };
    if ('display_name' in fields) patch.display_name = fields.display_name?.trim() || null;
    if ('age' in fields) patch.age = fields.age ?? null;
    if ('bio' in fields) patch.bio = fields.bio?.trim() || null;
    if ('neighborhood' in fields) patch.neighborhood = fields.neighborhood?.trim() || null;
    if ('favorite_sports' in fields) {
      patch.favorite_sports = fields.favorite_sports?.length ? fields.favorite_sports : null;
    }
    const { data, error } = await supabase
      .from('profiles')
      .upsert(patch, { onConflict: 'id' })
      .select(PROFILE_COLS)
      .single();
    if (!error) setProfile(data);
    return { data, error };
  };

  // Permanently delete the signed-in user's account. A SECURITY DEFINER RPC
  // (supabase/schema/09_account_deletion.sql) deletes their auth.users row,
  // which cascades away all their app data; then we end the local session.
  const deleteAccount = async () => {
    if (!userId) return { error: new Error(tg('err.notSignedIn')) };
    // Drop this device's push token while the session still authorizes it.
    await unregisterPush();
    const { error } = await supabase.rpc('delete_account');
    if (error) return { error };
    await supabase.auth.signOut();
    setProfile(null);
    return { error: null };
  };

  const value = {
    enabled,
    loading,
    session,
    user: session?.user ?? null,
    profile,
    displayName: profile?.display_name || null,
    signUp,
    signIn,
    signOut,
    updateProfile,
    deleteAccount,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext) || DISABLED;
}
