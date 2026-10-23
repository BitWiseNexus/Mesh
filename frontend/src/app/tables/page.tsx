import type { Metadata } from "next";

import { AuthGate } from "@/components/auth/auth-gate";
import { TablesPage } from "@/components/tables/tables-page";

export const metadata: Metadata = { title: "Tables · Mesh" };

export default function TablesRoute() {
  return (
    <AuthGate>
      <TablesPage />
    </AuthGate>
  );
}
