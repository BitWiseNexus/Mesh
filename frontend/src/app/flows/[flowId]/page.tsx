import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthGate, FullPageSpinner } from "@/components/auth/auth-gate";
import { FlowEditorRoute } from "@/components/editor/flow-editor-route";

export const metadata: Metadata = { title: "Editor · Mesh" };

export default function FlowEditorPage() {
  return (
    // On this dynamic route, URL hooks (usePathname in AuthGate, useParams in FlowEditorRoute)
    // must sit under a Suspense boundary with Cache Components.
    <Suspense fallback={<FullPageSpinner label="Opening flow…" />}>
      <AuthGate>
        <FlowEditorRoute />
      </AuthGate>
    </Suspense>
  );
}
