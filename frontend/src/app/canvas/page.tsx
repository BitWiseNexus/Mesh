import type { Metadata } from "next";

import { FlowEditor } from "@/components/editor/flow-editor";

export const metadata: Metadata = { title: "Canvas · Mesh" };

export default function CanvasPage() {
  return <FlowEditor />;
}
