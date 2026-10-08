"use client";

import { KeyRound, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { initials } from "@/lib/auth/auth-helpers";

import { useAuth } from "./auth-provider";

export function UserMenu() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  if (!user) return null;

  const label = user.displayName || user.email || "Account";

  // No navigation here: <AuthGate> sees the signed-out state and redirects to
  // /login?next=<current page>, so signing back in returns the user to where they were.
  const onSignOut = () => signOut();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account: ${label}`}
        className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {initials(user.displayName, user.email)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="space-y-0.5 py-1.5">
            {user.displayName && (
              <span className="block truncate text-sm font-medium text-foreground">
                {user.displayName}
              </span>
            )}
            <span className="block truncate">{user.email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/settings/api-keys")}>
          <KeyRound />
          API keys
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void onSignOut()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
