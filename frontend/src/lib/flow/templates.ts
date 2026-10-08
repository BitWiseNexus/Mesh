import { createDefaultData } from "@/lib/nodes/registry";
import type { Flow } from "@/types/flow";

import { newId, SCHEMA_VERSION } from "./graph";

export type FlowTemplate = "starter" | "blank";

/** What a new flow starts as: a Manual Trigger wired to an Output, or an empty canvas. */
export function createFlowFromTemplate(template: FlowTemplate = "starter"): Flow {
  const base: Flow = {
    schema_version: SCHEMA_VERSION,
    flow_id: null,
    name: "Untitled flow",
    description: "",
    nodes: [],
    edges: [],
  };
  if (template === "blank") return base;

  const trigger = newId("node");
  const output = newId("node");
  return {
    ...base,
    nodes: [
      {
        id: trigger,
        type: "trigger_manual",
        data: createDefaultData("trigger_manual"),
        position: { x: 0, y: 0 },
      },
      {
        id: output,
        type: "output_display",
        data: createDefaultData("output_display"),
        position: { x: 420, y: 0 },
      },
    ],
    edges: [
      {
        id: newId("edge"),
        source: trigger,
        sourceHandle: "out",
        target: output,
        targetHandle: "in",
        type: "data",
        animated: false,
      },
    ],
  };
}
