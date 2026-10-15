import { describe, expect, it } from "vitest";

import { useEditorUi } from "./editor-ui-store";

describe("palette open state", () => {
  it("remembers the wide-screen choice, but not the narrow-screen one", () => {
    const { setPaletteOpen } = useEditorUi.getState();
    setPaletteOpen(false, false);
    expect(useEditorUi.getState().wideOpen).toBe(false);
    expect(localStorage.getItem("mesh:palette-open")).toBe("0");

    setPaletteOpen(true, true);
    expect(useEditorUi.getState()).toMatchObject({ wideOpen: false, narrowOpen: true });
    expect(localStorage.getItem("mesh:palette-open")).toBe("0");

    setPaletteOpen(true, false);
    expect(localStorage.getItem("mesh:palette-open")).toBe("1");
  });
});
