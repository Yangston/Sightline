import { describe, expect, it } from "vitest";
import * as Cesium from "cesium";
import { frustumOrientationFromCamera } from "../../src/lib/photography-map/cesium-orientation";

function expectCartesianClose(
  actual: Cesium.Cartesian3,
  expected: Cesium.Cartesian3,
) {
  expect(actual.x).toBeCloseTo(expected.x, 12);
  expect(actual.y).toBeCloseTo(expected.y, 12);
  expect(actual.z).toBeCloseTo(expected.z, 12);
}

describe("Cesium frustum orientation", () => {
  it("preserves camera up and forward while reversing camera right", () => {
    const direction = Cesium.Cartesian3.normalize(
      new Cesium.Cartesian3(1, 2, -3),
      new Cesium.Cartesian3(),
    );
    const right = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.cross(
        direction,
        Cesium.Cartesian3.UNIT_Z,
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    );
    const up = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    const orientation = frustumOrientationFromCamera({
      directionWC: direction,
      rightWC: right,
      upWC: up,
    });
    const rotation = Cesium.Matrix3.fromQuaternion(orientation);

    expectCartesianClose(
      Cesium.Matrix3.getColumn(rotation, 0, new Cesium.Cartesian3()),
      Cesium.Cartesian3.negate(right, new Cesium.Cartesian3()),
    );
    expectCartesianClose(
      Cesium.Matrix3.getColumn(rotation, 1, new Cesium.Cartesian3()),
      up,
    );
    expectCartesianClose(
      Cesium.Matrix3.getColumn(rotation, 2, new Cesium.Cartesian3()),
      direction,
    );
  });
});
