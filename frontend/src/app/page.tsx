import Link from "next/link";

import { BackendStatus } from "@/components/backend-status";
import { buttonVariants } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <BackendStatus />
      <h1 className="text-4xl font-semibold tracking-tight">Mesh</h1>
      <p className="max-w-md text-muted-foreground">
        Build, run and watch multi-agent AI workflows on a visual canvas.
      </p>
      {/* A real link (not Button render=Link, which would get role="button"). */}
      <Link href="/canvas" className={buttonVariants({ size: "lg" })}>
        Open canvas
      </Link>
    </main>
  );
}
