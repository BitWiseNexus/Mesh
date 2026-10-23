"use client";

import { AlertCircle, RefreshCw, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { formatRelativeTime, plural } from "@/lib/format";
import { cellText, tableColumns } from "@/lib/tables";
import { ROWS_SHOWN, useDeleteRow, useDeleteTable, useRows, useTable } from "@/lib/tables-api";
import type { TableRow } from "@/types/tables";

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

function Cell({ value }: { value: unknown }) {
  const text = cellText(value);
  if (text === null) return <span className="text-muted-foreground/60">—</span>;
  return (
    <span className="block max-w-72 truncate" title={text}>
      {text}
    </span>
  );
}

function TableView({ id }: { id: string }) {
  const table = useTable(id);
  const rows = useRows(id);
  const deleteTable = useDeleteTable();
  const deleteRow = useDeleteRow(id);
  const router = useRouter();
  const [confirm, confirmDialog] = useConfirm();

  const info = table.data;
  if (table.isError) {
    const missing = table.error instanceof ApiError && table.error.status === 404;
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-16 text-center">
        <AlertCircle className="size-6 text-destructive" />
        <p className="font-medium">{missing ? "Table not found" : "Couldn't load the table"}</p>
        {!missing && <p className="text-sm text-muted-foreground">{table.error.message}</p>}
        <Link href="/tables" className="text-sm underline">
          All tables
        </Link>
      </div>
    );
  }
  if (!info) {
    return (
      <div className="space-y-3" aria-label="Loading table">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const onDeleteTable = async () => {
    const ok = await confirm({
      title: `Delete “${info.name}”?`,
      description: `This deletes the table and its ${plural(info.row_count, "row")}. Flows that write to it start a new, empty one. This can't be undone.`,
      confirmLabel: "Delete table",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteTable.mutateAsync(info.table_id);
      toast.success(`Deleted “${info.name}”`);
      router.push("/tables");
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't delete the table."));
    }
  };

  const onDeleteRow = async (row: TableRow) => {
    const ok = await confirm({
      title: "Delete this row?",
      description: `Row ${row.row_id} will be gone for good.`,
      confirmLabel: "Delete row",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteRow.mutateAsync(row.row_id);
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't delete the row."));
    }
  };

  const list = rows.data ?? [];
  const columns = tableColumns(list);

  return (
    <>
      {confirmDialog}
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto min-w-0">
          <p className="text-sm text-muted-foreground">
            <Link href="/tables" className="hover:text-foreground">
              Tables
            </Link>{" "}
            /
          </p>
          <h1 className="truncate text-2xl font-semibold tracking-tight">{info.name}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {plural(info.row_count, "row")} · Written {formatRelativeTime(info.updated_at)}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void Promise.all([rows.refetch(), table.refetch()])}
          disabled={rows.isFetching}
        >
          <RefreshCw className={rows.isFetching ? "animate-spin" : undefined} />
          Refresh
        </Button>
        <Button variant="outline" onClick={() => void onDeleteTable()}>
          <Trash2 />
          Delete
        </Button>
      </div>

      {rows.isPending ? (
        <Skeleton className="h-40 w-full" aria-label="Loading rows" />
      ) : rows.isError ? (
        <div role="alert" className="rounded-xl border px-6 py-8 text-center text-sm">
          <p className="font-medium">Couldn&apos;t load the rows</p>
          <p className="text-muted-foreground">{rows.error.message}</p>
        </div>
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
          No rows. Flows that write to “{info.name}” add them here.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm" aria-label={`Rows of ${info.name}`}>
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Row</th>
                  {columns.map((column) => (
                    <th key={column} className="px-3 py-2 font-medium whitespace-nowrap">
                      {column}
                    </th>
                  ))}
                  <th className="px-3 py-2 font-medium whitespace-nowrap">Written</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {list.map((row) => (
                  <tr key={row.row_id} aria-label={`Row ${row.row_id}`} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      <span className="block max-w-40 truncate" title={row.row_id}>
                        {row.row_id}
                      </span>
                    </td>
                    {columns.map((column) => (
                      <td key={column} className="px-3 py-2">
                        <Cell value={row.data[column]} />
                      </td>
                    ))}
                    <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">
                      {formatRelativeTime(row.updated_at)}
                    </td>
                    <td className="px-1 py-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete row ${row.row_id}`}
                        onClick={() => void onDeleteRow(row)}
                      >
                        <X />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {info.row_count > list.length && list.length >= ROWS_SHOWN && (
            <p className="text-xs text-muted-foreground">
              Showing the {ROWS_SHOWN} most recently written of {info.row_count.toLocaleString()} rows.
            </p>
          )}
        </div>
      )}
    </>
  );
}

/** `/tables/[tableId]`: one table's rows. */
export function TablePage() {
  // A page kept hidden by Next (Activity) sees the *current* URL's params: no id → nothing.
  const { tableId } = useParams<{ tableId?: string }>();
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-8 sm:px-6">
        {tableId && <TableView key={tableId} id={tableId} />}
      </main>
    </div>
  );
}
