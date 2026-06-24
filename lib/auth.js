// Account state for HoopMap, backed by Supabase Auth (email + password).
// Accounts are optional: when Supabase isn't configured (`supabase` is null),
// `enabled` is false and the app simply hides account/social features.
import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { unregisterPush } from './push';

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
  signUp: async () => ({ error: new Error('Accounts are not configured.') }),
  signIn: async () => ({ error: new Error('Accounts are not configured.') }),
  signOut: async () => {},
  updateDisplayName: async () => ({ error: new Error('Accounts are not configured.') }),
};

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
      .select('id, display_name')
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
    // public.profiles row created on signup (see supabase/schema.sql).
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

  const updateDisplayName = async (name) => {
    if (!userId) return { error: new Error('Not signed in') };
    const { data, error } = await supabase
      .from('profiles')
      .upsert({ id: userId, display_name: name.trim() }, { onConflict: 'id' })
      .select('id, display_name')
      .single();
    if (!error) setProfile(data);
    return { data, error };
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
    updateDisplayName,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext) || DISABLED;
}
