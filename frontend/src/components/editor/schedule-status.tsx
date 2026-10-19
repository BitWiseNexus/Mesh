"use client";

import { CalendarClock, CircleAlert, CirclePause } from "lucide-react";

import { formatInTimeZone, formatRelativeTime } from "@/lib/format";
import { useSchedules } from "@/lib/schedules-api";
import { useFlowStore } from "@/stores/flow-store";

const Note = ({ children }: { children: React.ReactNode }) => (
  <p className="text-xs text-muted-foreground">{children}</p>
);

/** What a Schedule trigger will do, as last saved: its next times, or why it won't run. */
export function ScheduleStatus({ nodeId }: { nodeId: string }) {
  const flowId = useFlowStore((s) => s.flowId);
  const version = useFlowStore((s) => s.version);
  const dirty = useFlowStore((s) => s.dirty);
  const schedules = useSchedules(flowId, version);
  const info = schedules.data?.find((s) => s.node_id === nodeId);

  let body: React.ReactNode;
  if (!flowId || (schedules.isSuccess && !info)) {
    body = <Note>The schedule starts once the flow is saved.</Note>;
  } else if (schedules.isPending) {
    body = <Note>Loading the schedule…</Note>;
  } else if (schedules.isError) {
    body = <Note>Couldn&apos;t load the schedule.</Note>;
  } else if (!info!.enabled) {
    body = (
      <p className="flex gap-1.5 text-xs text-muted-foreground">
        <CirclePause className="mt-px size-3.5 shrink-0" />
        Off — switch on “Run on this schedule” to start it.
      </p>
    );
  } else if (info!.problem) {
    body = (
      <p className="flex gap-1.5 text-xs text-destructive">
        <CircleAlert className="mt-px size-3.5 shrink-0" />
        Not scheduled: {info!.problem}
      </p>
    );
  } else {
    body = (
      <>
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
          Next runs ({info!.timezone})
        </p>
        <ul aria-label="Next runs" className="space-y-0.5 pl-5 text-xs tabular-nums">
          {info!.next_runs.map((at) => (
            <li key={at}>{formatInTimeZone(at, info!.timezone)}</li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <section aria-label="Schedule status" className="space-y-1.5 rounded-md border p-2.5">
      {body}
      {info?.last_fired_at && (
        <Note>
          Last due {formatRelativeTime(info.last_fired_at)}
          {info.last_error ? `. ${info.last_error}` : " — its run is in Run history."}
        </Note>
      )}
      {dirty && <Note>Unsaved changes apply once they&apos;re saved.</Note>}
    </section>
  );
}
