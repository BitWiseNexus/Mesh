"use client";

import { Waypoints } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ApprovalsMenu } from "@/components/approvals-menu";
import { UserMenu } from "@/components/auth/user-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { href: "/flows", label: "Flows" },
  { href: "/knowledge", label: "Knowledge" },
];

/** Top bar for app pages outside the editor. */
export function AppHeader() {
  const pathname = usePathname();
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
      <nav aria-label="Main" className="ml-4 flex items-center gap-1 text-sm">
        {SECTIONS.map(({ href, label }) => {
          const current = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={current ? "page" : undefined}
              className={cn(
                "rounded-md px-2 py-1 text-muted-foreground hover:text-foreground",
                current && "bg-muted font-medium text-foreground",
              )}
            >
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <ApprovalsMenu />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
