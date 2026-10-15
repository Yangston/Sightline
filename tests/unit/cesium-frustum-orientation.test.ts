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
  it.each([3 / 2, 2 / 3])(
    "projects actual frustum corners into the photo frame at aspect %s",
    (aspectRatio) => {
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
      const up = Cesium.Cartesian3.cross(
        right,
        direction,
        new Cesium.Cartesian3(),
      );
      const origin = Cesium.Cartesian3.fromDegrees(-79.38, 43.65, 150);
      const frustum = new Cesium.PerspectiveFrustum({
        fov: Math.PI / 3,
        aspectRatio,
        near: 1,
        far: 100,
      });
      const geometry = Cesium.FrustumGeometry.createGeometry(
        new Cesium.FrustumGeometry({
          origin,
          frustum,
          orientation: frustumOrientationFromCamera({
            directionWC: direction,
            rightWC: right,
            upWC: up,
          }),
        }),
      )!;
      const vertices = Array.from(geometry.attributes.position!.values);
      const halfHeight = Math.tan(frustum.fovy! / 2);
      for (let index = 0; index < vertices.length; index += 3) {
        const offset = Cesium.Cartesian3.subtract(
          Cesium.Cartesian3.fromArray(vertices, index),
          origin,
          new Cesium.Cartesian3(),
        );
        const depth = Cesium.Cartesian3.dot(offset, direction);
        const x =
          Cesium.Cartesian3.dot(offset, right) /
          (depth * halfHeight * aspectRatio);
        const y = Cesium.Cartesian3.dot(offset, up) / (depth * halfHeight);
        expect(depth).toBeGreaterThan(0);
        expect(Math.abs(x)).toBeCloseTo(1, 6);
        expect(Math.abs(y)).toBeCloseTo(1, 6);
      }
    },
  );

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
