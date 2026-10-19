/** A flow's schedules (backend/app/api/schedules.py): what each Schedule trigger will do. */
"use client";

import { useQuery } from "@tanstack/react-query";

import { useApi } from "@/components/auth/auth-provider";

export interface ScheduleInfo {
  node_id: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  /** The next few times it fires (empty when it's off or has a problem). */
  next_runs: string[];
  /** Why it isn't scheduled although it's switched on. */
  problem: string | null;
  last_fired_at: string | null;
  last_run_id: string | null;
  last_error: string | null;
}

/**
 * The schedules of the flow as saved at `version` — saving the flow updates them, so a new
 * version refetches. Also refreshed every minute while shown (the next times move on).
 */
export function useSchedules(flowId: string | null, version: number | null) {
  const api = useApi();
  return useQuery({
    queryKey: ["schedules", flowId, version],
    queryFn: () => api.get<ScheduleInfo[]>(`/flows/${encodeURIComponent(flowId!)}/schedules`),
    enabled: flowId !== null,
    refetchInterval: 60_000,
  });
}

/** The timezones Schedule triggers accept (UTC first), from the server — browsers' own lists use
 * other spellings for some zones (Chromium: Asia/Calcutta, not Asia/Kolkata). */
export function useTimezones() {
  const api = useApi();
  return useQuery({
    queryKey: ["timezones"],
    queryFn: () => api.get<string[]>("/timezones"),
    staleTime: Infinity,
  });
}
