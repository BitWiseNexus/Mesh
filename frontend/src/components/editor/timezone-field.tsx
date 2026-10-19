"use client";

import { Autocomplete } from "@base-ui/react/autocomplete";
import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTimezones } from "@/lib/schedules-api";

const NONE: string[] = [];

/**
 * An IANA timezone name, typed or picked from the server's list (the server also checks it: an
 * unknown zone shows up as the schedule's problem). Offers the user's own zone.
 */
export function TimezoneField({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  value: unknown;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const timezones = useTimezones();
  const zones = timezones.data ?? NONE;
  const mine = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const text = typeof value === "string" ? value : "";
  // Filter only while typing: opening the list on a chosen zone shows every option.
  const [typed, setTyped] = useState(false);
  const query = typed ? text.trim().toLowerCase() : "";
  const shown = query ? zones.filter((z) => z.toLowerCase().includes(query)) : zones;

  return (
    <>
      <Autocomplete.Root
        items={zones}
        filteredItems={shown}
        value={text}
        onValueChange={(next, details) => {
          onChange(next);
          setTyped(details.reason === "input-change");
        }}
        onOpenChange={(open) => open && setTyped(false)}
        openOnInputClick
      >
        <div className="relative">
          <Autocomplete.Input
            id={id}
            render={<Input className="pr-8" />}
            spellCheck={false}
            placeholder={placeholder}
          />
          <Autocomplete.Trigger
            aria-label="Show timezones"
            className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className="size-4" />
          </Autocomplete.Trigger>
        </div>
        <Autocomplete.Portal>
          <Autocomplete.Positioner sideOffset={4} className="z-50 outline-none">
            <Autocomplete.Popup
              aria-label="Timezones"
              className="max-h-[min(20rem,var(--available-height))] w-(--anchor-width) overflow-y-auto rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
            >
              <Autocomplete.Empty>
                <p className="px-2 py-1.5 text-muted-foreground">
                  {timezones.isPending ? "Loading timezones…" : "No timezone matches."}
                </p>
              </Autocomplete.Empty>
              <Autocomplete.List>
                {(zone: string) => (
                  <Autocomplete.Item
                    key={zone}
                    value={zone}
                    className="cursor-default rounded-md px-2 py-1 text-xs outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  >
                    {zone}
                  </Autocomplete.Item>
                )}
              </Autocomplete.List>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
      {mine && mine !== (text.trim() || "UTC") && (
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onChange(mine)}>
          Use my timezone ({mine})
        </Button>
      )}
    </>
  );
}
