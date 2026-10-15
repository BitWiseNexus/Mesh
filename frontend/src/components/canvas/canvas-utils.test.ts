import { describe, expect, it } from "vitest";

import { NODE_HEIGHT, NODE_WIDTH } from "@/lib/flow/graph";

import { centeredNodePosition, coveredSides, fitPadding, getCanvasCenter } from "./canvas-utils";

describe("getCanvasCenter", () => {
  it("converts the middle of the canvas element to a flow position", () => {
    const canvas = { getBoundingClientRect: () => ({ x: 100, y: 50, width: 800, height: 600 }) as DOMRect };
    const toFlow = ({ x, y }: { x: number; y: number }) => ({ x: x * 2, y: y * 2 });
    expect(getCanvasCenter(toFlow, canvas)).toEqual({ x: 1000, y: 700 });
  });

  it("falls back to the origin without a canvas", () => {
    expect(getCanvasCenter((p) => p, null)).toEqual({ x: 0, y: 0 });
  });
});

it("centres a new node on a point", () => {
  expect(centeredNodePosition({ x: 500, y: 300 })).toEqual({
    x: 500 - NODE_WIDTH / 2,
    y: 300 - NODE_HEIGHT / 2,
  });
});

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, right: left + width, bottom: top + height, x: left, y: top, width, height }) as DOMRect;

describe("fit view padding", () => {
  it("adds what floating panels cover to the usual relative margin", () => {
    // React Flow's padding 0.3 leaves floor((v − v / 1.3) / 2) px per side.
    expect(fitPadding(1300, 650, { left: 0, right: 0 })).toEqual({
      top: "75px",
      bottom: "75px",
      left: "150px",
      right: "150px",
    });
    // A 320px panel over the right: the margin is taken from the visible 980px, plus the panel.
    expect(fitPadding(1300, 650, { left: 0, right: 320 })).toMatchObject({
      left: "113px",
      right: `${113 + 320}px`,
    });
  });

  it("measures how far floating panels reach into the canvas", () => {
    const canvas = rect(0, 48, 1000, 700);
    expect(coveredSides(canvas, [])).toEqual({ left: 0, right: 0 });
    // Docked panels sit beside the canvas: no cover.
    expect(coveredSides(rect(288, 48, 800, 700), [rect(0, 48, 288, 700), rect(1088, 48, 320, 700)])).toEqual({
      left: 0,
      right: 0,
    });
    // Floating ones overlap it.
    expect(coveredSides(canvas, [rect(0, 48, 288, 700), rect(680, 48, 320, 700)])).toEqual({
      left: 288,
      right: 320,
    });
  });
});
