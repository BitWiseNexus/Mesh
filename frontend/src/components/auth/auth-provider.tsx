"use client";

import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";

import { createApiClient, type ApiClient } from "@/lib/api";
import { getFirebase } from "@/lib/firebase";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  user: User | null;
  status: AuthStatus;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (name: string, email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Firebase ID token for backend calls (refreshed automatically when near expiry). */
  getIdToken: (forceRefresh?: boolean) => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // `revision` forces a re-render when the same User object changes (e.g. updateProfile).
  const [state, setState] = useState<{ user: User | null; status: AuthStatus; revision: number }>({
    user: null,
    status: "loading",
    revision: 0,
  });

  useEffect(() => {
    const { auth } = getFirebase();
    return onAuthStateChanged(auth, (user) =>
      setState((s) => ({
        user,
        status: user ? "authenticated" : "unauthenticated",
        revision: s.revision + 1,
      })),
    );
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const auth = () => getFirebase().auth;
    return {
      user: state.user,
      status: state.status,
      signInWithEmail: async (email, password) => {
        await signInWithEmailAndPassword(auth(), email.trim(), password);
      },
      signUpWithEmail: async (name, email, password) => {
        const { user } = await createUserWithEmailAndPassword(auth(), email.trim(), password);
        if (name.trim()) {
          await updateProfile(user, { displayName: name.trim() });
          setState((s) => ({ ...s, user, revision: s.revision + 1 }));
        }
      },
      signInWithGoogle: async () => {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        await signInWithPopup(auth(), provider);
      },
      sendPasswordReset: async (email) => {
        await sendPasswordResetEmail(auth(), email.trim());
      },
      signOut: async () => {
        await firebaseSignOut(auth());
      },
      getIdToken: async (forceRefresh = false) => {
        const user = auth().currentUser;
        return user ? user.getIdToken(forceRefresh) : null;
      },
    };
    // Depends on the whole `state`: a new state object (incl. a bumped `revision`) means the
    // user may have changed even when the User reference didn't.
  }, [state]);

  return <AuthContext value={value}>{children}</AuthContext>;
}

/** Mesh API client authenticated as the signed-in user. Stable across renders. */
export function useApi(): ApiClient {
  const { getIdToken } = useAuth();
  return useMemo(() => createApiClient(getIdToken), [getIdToken]);
}

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
