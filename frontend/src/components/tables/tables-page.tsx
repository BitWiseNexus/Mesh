"use client";

import { AlertCircle, Table2 } from "lucide-react";
import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime, plural } from "@/lib/format";
import { useTables } from "@/lib/tables-api";

/** `/tables`: the tables the user's flows write to (Write to Table node). */
export function TablesPage() {
  const tables = useTables();
  const list = tables.data ?? [];

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tables</h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            Rows your flows saved with the Write to Table node. Only you can see them.
          </p>
        </div>

        {tables.isPending ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading tables">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : tables.isError ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 rounded-xl border px-6 py-12 text-center"
          >
            <AlertCircle className="size-6 text-destructive" />
            <p className="font-medium">Couldn&apos;t load your tables</p>
            <p className="max-w-md text-sm text-muted-foreground">{tables.error.message}</p>
            <Button variant="outline" onClick={() => void tables.refetch()}>
              Try again
            </Button>
          </div>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
            <Table2 className="size-8 text-muted-foreground" />
            <h2 className="font-medium">No tables yet</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Add a Write to Table node to a flow: it creates its table the first time it writes a
              row.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((table) => (
              <article
                key={table.table_id}
                aria-label={table.name}
                className="relative flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-xs transition-shadow focus-within:ring-2 focus-within:ring-ring/50 hover:shadow-md"
              >
                <div className="flex items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Table2 className="size-4" />
                  </div>
                  <h2 className="min-w-0 truncate font-medium">
                    {/* The link's ::after covers the card, so the whole card opens it. */}
                    <Link
                      href={`/tables/${table.table_id}`}
                      className="outline-none after:absolute after:inset-0 after:rounded-xl"
                    >
                      {table.name}
                    </Link>
                  </h2>
                </div>
                <p className="text-xs text-muted-foreground">
                  {plural(table.row_count, "row")} · Written {formatRelativeTime(table.updated_at)}
                </p>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
