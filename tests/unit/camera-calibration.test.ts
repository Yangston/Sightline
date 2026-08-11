import { describe, expect, it } from "vitest";
import {
  containedImagePoint,
  projectWorldPoint,
  refineCameraFromControlPoints,
  refineOrientationFromControlPoints,
  type CalibrationCamera,
  type CalibrationControlPoint,
} from "../../src/lib/photography-map/calibration";

describe("2D-to-3D camera calibration", () => {
  it("maps contained-image clicks without counting letterbox space", () => {
    expect(containedImagePoint(1_200, 600, 600, 900, 600, 300)).toEqual({
      xPx: 300,
      yPx: 450,
    });
    expect(containedImagePoint(1_200, 600, 600, 900, 200, 300)).toBeUndefined();
  });

  it("projects a point on the optical axis to the image center", () => {
    const camera: CalibrationCamera = {
      position: { latitude: 43, longitude: -79, altitudeM: 100 },
      headingDeg: 0,
      pitchDeg: 0,
      rollDeg: 0,
      horizontalFovDeg: 60,
      verticalFovDeg: 40,
      imageWidth: 1_500,
      imageHeight: 1_000,
    };
    const projected = projectWorldPoint(camera, {
      latitude: 43.001,
      longitude: -79,
      altitudeM: 100,
    });
    expect(projected?.xPx).toBeCloseTo(750, 1);
    expect(projected?.yPx).toBeCloseTo(500, 0);
  });

  it("refines a nearby EXIF pose from synthetic control points", () => {
    const truth: CalibrationCamera = {
      position: { latitude: 43, longitude: -79, altitudeM: 100 },
      headingDeg: 4,
      pitchDeg: 3,
      rollDeg: -1,
      horizontalFovDeg: 60,
      verticalFovDeg: 40,
      imageWidth: 1_500,
      imageHeight: 1_000,
    };
    const world = [
      { latitude: 43.001, longitude: -79.0003, altitudeM: 90 },
      { latitude: 43.0012, longitude: -79.0001, altitudeM: 115 },
      { latitude: 43.0011, longitude: -78.9998, altitudeM: 100 },
      { latitude: 43.0015, longitude: -79.0004, altitudeM: 125 },
      { latitude: 43.0016, longitude: -79, altitudeM: 80 },
      { latitude: 43.0014, longitude: -78.9996, altitudeM: 108 },
    ];
    const points: CalibrationControlPoint[] = world.map((point) => {
      const projected = projectWorldPoint(truth, point)!;
      return { image: projected, world: point };
    });
    const solution = refineCameraFromControlPoints(
      {
        ...truth,
        headingDeg: 7,
        pitchDeg: 0,
        rollDeg: 1,
      },
      points,
    );
    expect(solution.headingDeg).toBeCloseTo(truth.headingDeg, 0);
    expect(solution.pitchDeg).toBeCloseTo(truth.pitchDeg, 0);
    expect(solution.rollDeg).toBeCloseTo(truth.rollDeg, 0);
    expect(solution.rmsErrorPx).toBeLessThan(3);
  });

  it("refines heading and pitch from one landmark without moving the camera", () => {
    const truth: CalibrationCamera = {
      position: { latitude: 25.0267, longitude: 121.5758, altitudeM: 202 },
      headingDeg: 304,
      pitchDeg: 10,
      rollDeg: 0.16,
      horizontalFovDeg: 12.35,
      verticalFovDeg: 16.41,
      imageWidth: 1_536,
      imageHeight: 2_048,
    };
    const world = {
      latitude: 25.033968,
      longitude: 121.564468,
      altitudeM: 520,
    };
    const image = projectWorldPoint(truth, world)!;
    const solution = refineOrientationFromControlPoints(
      { ...truth, headingDeg: 307, pitchDeg: 7 },
      [{ image, world }],
    );
    expect(solution.position).toEqual(truth.position);
    expect(solution.horizontalFovDeg).toBe(truth.horizontalFovDeg);
    expect(solution.verticalFovDeg).toBe(truth.verticalFovDeg);
    expect(solution.rollDeg).toBe(truth.rollDeg);
    expect(solution.headingDeg).toBeCloseTo(truth.headingDeg, 1);
    expect(solution.pitchDeg).toBeCloseTo(truth.pitchDeg, 1);
    expect(solution.rmsErrorPx).toBeLessThan(1);
  });
});
