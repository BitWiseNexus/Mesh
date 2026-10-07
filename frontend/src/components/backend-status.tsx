"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/api";

type Status = "checking" | "online" | "offline";

export function BackendStatus() {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ status: string }>("/health")
      .then((data) => !cancelled && setStatus(data.status === "ok" ? "online" : "offline"))
      .catch(() => !cancelled && setStatus("offline"));
    return () => {
      cancelled = true;
    };
  }, []);

  const variant = status === "online" ? "default" : status === "offline" ? "destructive" : "outline";
  return <Badge variant={variant}>Backend: {status}</Badge>;
}
