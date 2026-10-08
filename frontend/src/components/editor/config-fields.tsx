"use client";

import { useId, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { FieldDef } from "@/lib/nodes/registry";
import { cn } from "@/lib/utils";

interface FieldProps<F extends FieldDef = FieldDef> {
  field: F;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Set when flow validation reports a problem with this field. */
  invalid?: boolean;
}

type Of<K extends FieldDef["kind"]> = Extract<FieldDef, { kind: K }>;

function NumberInput({
  field,
  value,
  onChange,
  invalid,
  id,
}: FieldProps<Of<"number">> & { id: string }) {
  // Keep a string draft so users can type intermediate states like "" or "0.".
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    if (Number(draft) !== value) setDraft(value == null ? "" : String(value));
  }

  return (
    <Input
      id={id}
      type="number"
      inputMode="decimal"
      aria-invalid={invalid || undefined}
      aria-required={field.required || undefined}
      min={field.min}
      max={field.max}
      step={field.step}
      value={draft}
      placeholder={field.placeholder}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = e.target.valueAsNumber;
        if (!Number.isNaN(n)) onChange(n);
      }}
    />
  );
}

function JsonInput({ field, value, onChange, id }: FieldProps<Of<"json">> & { id: string }) {
  const format = (v: unknown) => JSON.stringify(v ?? null, null, 2);
  const [draft, setDraft] = useState(() => format(value));
  const [prev, setPrev] = useState(value);
  const [error, setError] = useState<string | null>(null);
  if (value !== prev) {
    setPrev(value);
    setDraft(format(value));
    setError(null);
  }

  return (
    <>
      <Textarea
        id={id}
        rows={field.rows ?? 4}
        value={draft}
        spellCheck={false}
        aria-invalid={error != null}
        className="font-mono text-xs"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          try {
            onChange(JSON.parse(draft));
            setError(null);
          } catch {
            setError("Invalid JSON — not saved");
          }
        }}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </>
  );
}

export function ConfigField({ field, value, onChange, invalid }: FieldProps) {
  const id = useId();
  const listId = `${id}-suggestions`;
  const a11y = {
    "aria-invalid": invalid || undefined,
    "aria-required": field.required || undefined,
  };

  if (field.kind === "switch") {
    return (
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="font-normal">
          {field.label}
        </Label>
        <Switch id={id} checked={value === true} onCheckedChange={(checked) => onChange(checked)} />
      </div>
    );
  }

  let control: React.ReactNode;
  switch (field.kind) {
    case "text":
      control = (
        <>
          <Input
            id={id}
            {...a11y}
            value={typeof value === "string" ? value : ""}
            placeholder={field.placeholder}
            list={field.suggestions ? listId : undefined}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.suggestions && (
            <datalist id={listId}>
              {field.suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
        </>
      );
      break;
    case "textarea":
    case "code":
      control = (
        <Textarea
          id={id}
          {...a11y}
          rows={field.rows ?? 3}
          value={typeof value === "string" ? value : ""}
          placeholder={field.placeholder}
          spellCheck={field.kind === "code" ? false : undefined}
          className={cn(field.kind === "code" && "font-mono text-xs")}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case "number":
      control = (
        <NumberInput id={id} field={field} value={value} onChange={onChange} invalid={invalid} />
      );
      break;
    case "json":
      control = <JsonInput id={id} field={field} value={value} onChange={onChange} />;
      break;
    case "select":
      control = (
        <Select
          value={typeof value === "string" ? value : null}
          onValueChange={(v) => onChange(v)}
          items={Object.fromEntries(field.options.map((o) => [o.value, o.label]))}
        >
          <SelectTrigger id={id} {...a11y} className="w-full">
            <SelectValue placeholder={field.placeholder ?? "Select…"} />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
      break;
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {field.label}
        {field.required && (
          <span aria-hidden className="-ml-1 text-destructive">
            *
          </span>
        )}
      </Label>
      {control}
      {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
    </div>
  );
}
