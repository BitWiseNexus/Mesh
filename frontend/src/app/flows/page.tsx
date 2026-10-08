import type { Metadata } from "next";

import { AuthGate } from "@/components/auth/auth-gate";
import { FlowsDashboard } from "@/components/dashboard/flows-dashboard";

export const metadata: Metadata = { title: "Flows · Mesh" };

export default function FlowsPage() {
  return (
    <AuthGate>
      <FlowsDashboard />
    </AuthGate>
  );
}
