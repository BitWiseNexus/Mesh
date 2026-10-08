/** Pure auth helpers (no Firebase imports) so they're easy to unit test. */

export const DEFAULT_AFTER_LOGIN = "/flows";

/**
 * Validates a post-login redirect target. Only same-origin paths are allowed, so a crafted
 * `/login?next=https://evil.example` can't turn the login page into an open redirect.
 */
export function safeRedirectPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return DEFAULT_AFTER_LOGIN;
  }
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/login/")) {
    return DEFAULT_AFTER_LOGIN;
  }
  return next;
}

const MESSAGES: Record<string, string> = {
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/invalid-login-credentials": "Email or password is incorrect.",
  "auth/wrong-password": "Email or password is incorrect.",
  "auth/user-not-found": "Email or password is incorrect.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/missing-email": "Enter your email address.",
  "auth/missing-password": "Enter your password.",
  "auth/email-already-in-use": "An account with this email already exists. Sign in instead.",
  "auth/weak-password": "Use a password with at least 6 characters.",
  "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/network-request-failed": "Can't reach the sign-in service. Check your connection.",
  "auth/popup-blocked": "Your browser blocked the sign-in popup. Allow popups and try again.",
  "auth/account-exists-with-different-credential":
    "This email is already registered with a different sign-in method.",
};

/** Codes that mean the user simply backed out — show nothing. */
const SILENT = new Set(["auth/popup-closed-by-user", "auth/cancelled-popup-request"]);

/** A user-facing message for a Firebase Auth error, or null when nothing should be shown. */
export function authErrorMessage(error: unknown): string | null {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (SILENT.has(code)) return null;
  return MESSAGES[code] ?? "Something went wrong. Please try again.";
}

/** Initials for an avatar fallback: "Ada Lovelace" → "AL", "ada@x.io" → "A". */
export function initials(name: string | null | undefined, email: string | null | undefined): string {
  const source = name?.trim() || email?.trim() || "?";
  const words = source.split(/[\s@._-]+/).filter(Boolean);
  if (name?.trim() && words.length > 1) return (words[0][0] + words.at(-1)![0]).toUpperCase();
  return source[0].toUpperCase();
}
