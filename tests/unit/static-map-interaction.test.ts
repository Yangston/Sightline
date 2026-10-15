import { describe, expect, it } from "vitest";
import {
  clampStaticMapTransform,
  STATIC_MAP_MAX_SCALE,
  zoomStaticMapTransform,
} from "../../src/lib/photography-map/static-interaction";

describe("static map interaction", () => {
  it("keeps the image covering its viewport while panning", () => {
    expect(
      clampStaticMapTransform({ x: 900, y: -900, scale: 2 }, 800, 600),
    ).toEqual({ x: 400, y: -300, scale: 2 });
  });

  it("clamps zoom to the supported detail range", () => {
    expect(
      clampStaticMapTransform({ x: 0, y: 0, scale: 20 }, 800, 600).scale,
    ).toBe(STATIC_MAP_MAX_SCALE);
    expect(
      clampStaticMapTransform({ x: 10, y: 10, scale: 0.2 }, 800, 600),
    ).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("zooms around the pointer rather than jumping to center", () => {
    expect(
      zoomStaticMapTransform({ x: 0, y: 0, scale: 1 }, 2, 200, -100, 800, 600),
    ).toEqual({ x: -200, y: 100, scale: 2 });
  });
});
