"use client";

import { Waypoints } from "lucide-react";
import Link from "next/link";

import { UserMenu } from "@/components/auth/user-menu";
import { ThemeToggle } from "@/components/theme-toggle";

/** Top bar for app pages outside the editor. */
export function AppHeader() {
  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur">
      <Link
        href="/flows"
        className="flex items-center gap-1.5 font-semibold tracking-tight"
        aria-label="Mesh — all flows"
      >
        <Waypoints className="size-4" />
        Mesh
      </Link>
      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
