"use client";

import { FileQuestion, Loader2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useLayoutEffect, useState } from "react";

import { useAuth } from "@/components/auth/auth-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { useFlow } from "@/lib/flows-queries";
import { bindDraft, useFlowStore } from "@/stores/flow-store";

import { FlowEditor } from "./flow-editor";

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      {children}
    </div>
  );
}

/**
 * False while Next.js keeps this page mounted but hidden (<Activity>) after navigating away.
 * Layout effects are torn down when a page is hidden and set up again when it's shown.
 */
function usePageIsActive(): boolean {
  const [active, setActive] = useState(false);
  useLayoutEffect(() => {
    setActive(true); // eslint-disable-line react-hooks/set-state-in-effect -- tracks Activity visibility
    return () => setActive(false);
  }, []);
  return active;
}

/** Loads `/flows/[flowId]` from the server into the editor store, then shows the editor. */
export function FlowEditorRoute() {
  const active = usePageIsActive();
  const { flowId } = useParams<{ flowId: string }>();
  const { user } = useAuth();
  const query = useFlow(flowId);
  const loadedId = useFlowStore((s) => s.flowId);

  // Load into the store when this route's flow isn't the one in it (first open, or coming back
  // after editing another flow). Don't reload on refetches: that would discard local edits.
  useEffect(() => {
    if (!query.data || !user || useFlowStore.getState().flowId === flowId) return;
    bindDraft(user.uid, flowId);
    useFlowStore.getState().loadFlow(query.data);
  }, [query.data, flowId, user]);

  // A hidden (preserved) editor page sees the *current* URL's params, so it would mount a second,
  // invisible editor for whatever flow is open now. Render nothing while hidden instead.
  if (!active) return null;

  if (query.error) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <CenteredMessage>
        <FileQuestion className="size-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold">
          {notFound ? "Flow not found" : "Couldn't load this flow"}
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {notFound
            ? "It may have been deleted, or it belongs to another account."
            : query.error.message}
        </p>
        <div className="flex gap-2">
          {!notFound && (
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          )}
          <Link href="/flows" className={buttonVariants()}>
            Back to flows
          </Link>
        </div>
      </CenteredMessage>
    );
  }

  if (!query.data || loadedId !== flowId) {
    return (
      <CenteredMessage>
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Opening flow…</p>
      </CenteredMessage>
    );
  }

  // key: a fresh canvas (viewport, fitView) per flow.
  return <FlowEditor key={flowId} />;
}
