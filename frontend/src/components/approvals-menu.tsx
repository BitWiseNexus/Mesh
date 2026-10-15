"use client";

import { useQuery } from "@tanstack/react-query";
import { Bell, Hourglass } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { useApi } from "@/components/auth/auth-provider";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatRelativeTime } from "@/lib/format";
import { runKeys, runsApi } from "@/lib/runs-api";

/** How often the menu looks for new approvals (also on focus, and when a run of yours pauses). */
const POLL_MS = 20_000;

/**
 * In-app notifications: the Approval Gates waiting for the user, across all their flows. Picking
 * one opens its flow with that run shown (`?run=`), where it can be answered.
 */
export function ApprovalsMenu() {
  const api = useApi();
  const runs = useMemo(() => runsApi(api), [api]);
  const router = useRouter();
  const approvals = useQuery({
    queryKey: runKeys.approvals,
    queryFn: runs.approvals,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });
  const items = approvals.data ?? [];
  const label =
    items.length === 0
      ? "Approvals"
      : `${items.length} approval${items.length === 1 ? "" : "s"} waiting for you`;

  return (
    <DropdownMenu>
      <Hint label={label}>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={label} className="relative" />}
        >
          <Bell />
          {items.length > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] leading-none font-semibold text-white">
              {items.length > 9 ? "9+" : items.length}
            </span>
          )}
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Waiting for your approval</DropdownMenuLabel>
          {items.length === 0 ? (
            <DropdownMenuItem disabled>Nothing waiting for you</DropdownMenuItem>
          ) : (
            items.map((item) => (
              <DropdownMenuItem
                key={`${item.run_id}:${item.node_id}`}
                className="items-start"
                onClick={() => router.push(`/flows/${item.flow_id}?run=${item.run_id}`)}
              >
                <Hourglass className="mt-0.5 text-amber-600 dark:text-amber-500" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {item.flow_name || "Untitled flow"}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.message}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {formatRelativeTime(item.requested_at)}
                  </span>
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
