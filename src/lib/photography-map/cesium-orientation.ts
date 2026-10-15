import * as Cesium from "cesium";

type CameraWorldAxes = Pick<Cesium.Camera, "directionWC" | "rightWC" | "upWC">;

export function frustumOrientationFromCamera(camera: CameraWorldAxes) {
  const rotation = new Cesium.Matrix3();
  const frustumRight = Cesium.Cartesian3.negate(
    camera.rightWC,
    new Cesium.Cartesian3(),
  );

  // FrustumGeometry negates its local x axis while reconstructing the view.
  // Match Cesium's DebugCameraPrimitive by supplying the opposite camera right.
  Cesium.Matrix3.setColumn(rotation, 0, frustumRight, rotation);
  Cesium.Matrix3.setColumn(rotation, 1, camera.upWC, rotation);
  Cesium.Matrix3.setColumn(rotation, 2, camera.directionWC, rotation);
  return Cesium.Quaternion.fromRotationMatrix(rotation);
}
