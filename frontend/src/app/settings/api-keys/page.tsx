import type { Metadata } from "next";

import { AuthGate } from "@/components/auth/auth-gate";
import { ApiKeysPage } from "@/components/credentials/api-keys-page";

export const metadata: Metadata = { title: "API keys · Mesh" };

export default function ApiKeysRoute() {
  return (
    <AuthGate>
      <ApiKeysPage />
    </AuthGate>
  );
}
