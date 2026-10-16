import type { Metadata } from "next";

import { AuthGate } from "@/components/auth/auth-gate";
import { KnowledgeBasesPage } from "@/components/knowledge/knowledge-bases-page";

export const metadata: Metadata = { title: "Knowledge bases · Mesh" };

export default function KnowledgeRoute() {
  return (
    <AuthGate>
      <KnowledgeBasesPage />
    </AuthGate>
  );
}
