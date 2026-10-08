"use client";

import { Loader2, Waypoints } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authErrorMessage, safeRedirectPath } from "@/lib/auth/auth-helpers";

import { useAuth } from "./auth-provider";

type Mode = "sign-in" | "sign-up";

function GoogleLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

export function LoginForm() {
  const { status, signInWithEmail, signUpWithEmail, signInWithGoogle, sendPasswordReset } =
    useAuth();
  const router = useRouter();
  const next = safeRedirectPath(useSearchParams().get("next"));

  const [mode, setMode] = useState<Mode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"email" | "google" | "reset" | null>(null);

  // Next.js keeps visited pages mounted but hidden (<Activity>) and restores their state when you
  // come back. For a login form that would mean the previous person's email and password still
  // filled in after they sign out. Reset everything as the page is hidden (layout cleanup runs
  // synchronously, before it's shown again).
  useLayoutEffect(
    () => () => {
      setMode("sign-in");
      setName("");
      setEmail("");
      setPassword("");
      setError(null);
      setPending(null);
    },
    [],
  );

  // Signed in (now or already): continue to where the user was going.
  useEffect(() => {
    if (status === "authenticated") router.replace(next);
  }, [status, next, router]);

  const run = async (kind: NonNullable<typeof pending>, action: () => Promise<void>) => {
    setError(null);
    setPending(kind);
    try {
      await action();
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setPending(null);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void run("email", () =>
      mode === "sign-in" ? signInWithEmail(email, password) : signUpWithEmail(name, email, password),
    );
  };

  const onForgotPassword = () => {
    if (!email.trim()) {
      setError("Enter your email address first, then choose “Forgot password?”.");
      return;
    }
    void run("reset", async () => {
      await sendPasswordReset(email);
      toast.success(`If an account exists for ${email.trim()}, a reset link is on its way.`);
    });
  };

  const switchMode = () => {
    setMode(mode === "sign-in" ? "sign-up" : "sign-in");
    setError(null);
  };

  const busy = pending !== null || status === "authenticated";
  const isSignUp = mode === "sign-up";

  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="space-y-2 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Waypoints className="size-5" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {isSignUp ? "Create your Mesh account" : "Sign in to Mesh"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isSignUp ? "Start building AI workflows in minutes." : "Welcome back."}
        </p>
      </div>

      <Button
        type="button"
        variant="outline"
        size="lg"
        className="w-full"
        disabled={busy}
        onClick={() => void run("google", signInWithGoogle)}
      >
        {pending === "google" ? <Loader2 className="animate-spin" /> : <GoogleLogo />}
        Continue with Google
      </Button>

      <div className="flex items-center gap-3 text-xs text-muted-foreground uppercase">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {isSignUp && (
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            {!isSignUp && (
              <button
                type="button"
                onClick={onForgotPassword}
                disabled={busy}
                className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Forgot password?
              </button>
            )}
          </div>
          <Input
            id="password"
            type="password"
            autoComplete={isSignUp ? "new-password" : "current-password"}
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {isSignUp && <p className="text-xs text-muted-foreground">At least 6 characters.</p>}
        </div>

        {error && (
          <p
            id="auth-error"
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {pending === "email" && <Loader2 className="animate-spin" />}
          {isSignUp ? "Create account" : "Sign in"}
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        {isSignUp ? "Already have an account?" : "New to Mesh?"}{" "}
        <button
          type="button"
          onClick={switchMode}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          {isSignUp ? "Sign in" : "Create an account"}
        </button>
      </p>
    </div>
  );
}
