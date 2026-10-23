/** Tables (backend/app/api/tables.py): typed endpoints and TanStack Query hooks. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useApi } from "@/components/auth/auth-provider";
import type { ApiClient } from "@/lib/api";
import type { TableInfo, TableRow } from "@/types/tables";

/** Rows shown on a table's page: the most recently written. */
export const ROWS_SHOWN = 100;

export function tablesApi(api: ApiClient) {
  const path = (id: string) => `/tables/${encodeURIComponent(id)}`;
  return {
    list: () => api.get<TableInfo[]>("/tables"),
    get: (id: string) => api.get<TableInfo>(path(id)),
    rows: (id: string) => api.get<TableRow[]>(`${path(id)}/rows?limit=${ROWS_SHOWN}`),
    remove: (id: string) => api.delete(path(id)),
    removeRow: (id: string, rowId: string) =>
      api.delete(`${path(id)}/rows/${encodeURIComponent(rowId)}`),
  };
}

export const tableKeys = {
  list: ["tables"] as const,
  detail: (id: string) => ["tables", id] as const,
  rows: (id: string) => ["tables", id, "rows"] as const,
};

function useTablesApi() {
  const api = useApi();
  return useMemo(() => tablesApi(api), [api]);
}

export function useTables() {
  const tables = useTablesApi();
  return useQuery({ queryKey: tableKeys.list, queryFn: tables.list });
}

export function useTable(id: string) {
  const tables = useTablesApi();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: tableKeys.detail(id),
    queryFn: () => tables.get(id),
    // Shown straight away when coming from the list.
    initialData: () =>
      queryClient.getQueryData<TableInfo[]>(tableKeys.list)?.find((t) => t.table_id === id),
  });
}

export function useRows(id: string) {
  const tables = useTablesApi();
  return useQuery({ queryKey: tableKeys.rows(id), queryFn: () => tables.rows(id) });
}

export function useDeleteTable() {
  const tables = useTablesApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: tables.remove,
    onSuccess: (_, id) =>
      queryClient.setQueryData<TableInfo[]>(tableKeys.list, (list) =>
        list?.filter((t) => t.table_id !== id),
      ),
  });
}

export function useDeleteRow(id: string) {
  const tables = useTablesApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rowId: string) => tables.removeRow(id, rowId),
    onSuccess: (_, rowId) => {
      queryClient.setQueryData<TableRow[]>(tableKeys.rows(id), (rows) =>
        rows?.filter((r) => r.row_id !== rowId),
      );
      void queryClient.invalidateQueries({ queryKey: tableKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: tableKeys.list });
    },
  });
}
