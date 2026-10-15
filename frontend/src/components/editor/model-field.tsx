"use client";

import { Autocomplete } from "@base-ui/react/autocomplete";
import { ChevronDown, Star } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { modelGroups, providerOfModel, useModels, type ProviderModels } from "@/lib/models-api";
import { cn } from "@/lib/utils";

const KEY_HINT: Record<ProviderModels["key"], (name: string) => string> = {
  saved: (name) => `Uses your saved ${name} key.`,
  server: (name) => `Uses the server's ${name} key.`,
  none: (name) => `No ${name} key yet — runs will fail until you add one.`,
  not_needed: () => "Test model: needs no API key.",
};

/**
 * An LLM model name: free text (any model LiteLLM supports) with suggestions from the server —
 * the models of the providers that have a key (recommended first), plus the test models outside
 * production. Says where the key for the chosen model comes from.
 */
export function ModelField({
  id,
  value,
  onChange,
  invalid,
  required,
}: {
  id: string;
  value: unknown;
  onChange: (value: string) => void;
  invalid?: boolean;
  required?: boolean;
}) {
  const models = useModels();
  const text = typeof value === "string" ? value : "";
  const providers = models.data?.providers ?? [];
  // Filter only while typing: opening the list on a chosen model shows every option.
  const [typed, setTyped] = useState(false);
  const groups = modelGroups(providers, typed ? text : "");
  const noKey = providers.filter((p) => p.key === "none");
  const provider = text.trim() ? providerOfModel(text, providers) : undefined;

  return (
    <>
      <Autocomplete.Root
        items={groups}
        filteredItems={groups}
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
            aria-invalid={invalid || undefined}
            aria-required={required || undefined}
            spellCheck={false}
            placeholder="e.g. claude-sonnet-5"
          />
          <Autocomplete.Trigger
            aria-label="Show models"
            className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className="size-4" />
          </Autocomplete.Trigger>
        </div>
        <Autocomplete.Portal>
          <Autocomplete.Positioner sideOffset={4} className="z-50 outline-none">
            <Autocomplete.Popup
              aria-label="Models"
              className="max-h-[min(24rem,var(--available-height))] w-(--anchor-width) overflow-y-auto rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
            >
              <Autocomplete.Empty>
                <p className="px-2 py-1.5 text-muted-foreground">
                  {models.isPending ? "Loading models…" : "No suggestions — any model name LiteLLM supports works."}
                </p>
              </Autocomplete.Empty>
              <Autocomplete.List>
                {(group: ReturnType<typeof modelGroups>[number]) => (
                  <Autocomplete.Group key={group.value} items={group.items} className="pb-1 last:pb-0">
                    <Autocomplete.GroupLabel className="px-2 py-1 text-xs font-medium text-muted-foreground">
                      {group.value}
                    </Autocomplete.GroupLabel>
                    <Autocomplete.Collection>
                      {(model: string) => (
                        <Autocomplete.Item
                          key={model}
                          value={model}
                          className="flex cursor-default items-center gap-2 rounded-md px-2 py-1 font-mono text-xs outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                        >
                          <span className="flex-1 truncate">{model}</span>
                          {group.provider.recommended.includes(model) && (
                            <Star aria-label="Recommended" className="size-3 text-amber-500" />
                          )}
                        </Autocomplete.Item>
                      )}
                    </Autocomplete.Collection>
                  </Autocomplete.Group>
                )}
              </Autocomplete.List>
              {noKey.length > 0 && (
                <p className="border-t px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
                  Add an API key to use {noKey.map((p) => p.name).join(", ")}:{" "}
                  <Link href="/settings/api-keys" className="underline">
                    API keys
                  </Link>
                </p>
              )}
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
      {provider && (
        <p
          className={cn(
            "text-xs",
            provider.key === "none" ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground",
          )}
        >
          {KEY_HINT[provider.key](provider.name)}{" "}
          {provider.key === "none" && (
            <Link href="/settings/api-keys" className="underline">
              Add a key
            </Link>
          )}
        </p>
      )}
    </>
  );
}
