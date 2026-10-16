import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthGate, FullPageSpinner } from "@/components/auth/auth-gate";
import { KnowledgeBasePage } from "@/components/knowledge/knowledge-base-page";

export const metadata: Metadata = { title: "Knowledge base · Mesh" };

export default function KnowledgeBaseRoute() {
  return (
    // URL hooks (usePathname in AuthGate, useParams in the page) need a Suspense boundary here.
    <Suspense fallback={<FullPageSpinner label="Opening knowledge base…" />}>
      <AuthGate>
        <KnowledgeBasePage />
      </AuthGate>
    </Suspense>
  );
}
