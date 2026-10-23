import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthGate, FullPageSpinner } from "@/components/auth/auth-gate";
import { TablePage } from "@/components/tables/table-page";

export const metadata: Metadata = { title: "Table · Mesh" };

export default function TableRoute() {
  return (
    // URL hooks (usePathname in AuthGate, useParams in the page) need a Suspense boundary here.
    <Suspense fallback={<FullPageSpinner label="Opening table…" />}>
      <AuthGate>
        <TablePage />
      </AuthGate>
    </Suspense>
  );
}
