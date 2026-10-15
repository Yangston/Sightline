import type { GeoPosition } from "./types";

const WGS84_A = 6_378_137;
const WGS84_E2 = 6.69437999014e-3;

export type Vec3 = { x: number; y: number; z: number };

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

export function fovFrom35mmEquivalent(
  focalLength35Mm: number,
  width: number,
  height: number,
) {
  if (focalLength35Mm <= 0 || width <= 0 || height <= 0)
    throw new Error("Focal length and dimensions must be positive.");
  const fullFrameDiagonal = Math.hypot(36, 24);
  const imageDiagonal = Math.hypot(width, height);
  const diagonalFov = 2 * Math.atan(fullFrameDiagonal / (2 * focalLength35Mm));
  const tangent = Math.tan(diagonalFov / 2);
  return {
    horizontalFovDeg: toDegrees(
      2 * Math.atan((tangent * width) / imageDiagonal),
    ),
    verticalFovDeg: toDegrees(
      2 * Math.atan((tangent * height) / imageDiagonal),
    ),
  };
}

export function fovFromSensor(
  focalLengthMm: number,
  sensorWidthMm: number,
  sensorHeightMm: number,
) {
  if (
    [focalLengthMm, sensorWidthMm, sensorHeightMm].some((value) => value <= 0)
  )
    throw new Error("Optics values must be positive.");
  return {
    horizontalFovDeg: toDegrees(
      2 * Math.atan(sensorWidthMm / (2 * focalLengthMm)),
    ),
    verticalFovDeg: toDegrees(
      2 * Math.atan(sensorHeightMm / (2 * focalLengthMm)),
    ),
  };
}

export function fovFromHorizontal(
  horizontalFovDeg: number,
  width: number,
  height: number,
) {
  if (
    horizontalFovDeg <= 0 ||
    horizontalFovDeg >= 180 ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("Horizontal FOV and dimensions must be valid.");
  return {
    horizontalFovDeg,
    verticalFovDeg: toDegrees(
      2 *
        Math.atan(Math.tan(toRadians(horizontalFovDeg) / 2) * (height / width)),
    ),
  };
}

export function cropAwareFov(
  horizontalFovDeg: number,
  verticalFovDeg: number,
  imageAspect: number,
  viewportAspect: number,
) {
  if (viewportAspect > imageAspect) {
    return {
      horizontalFovDeg,
      verticalFovDeg: toDegrees(
        2 *
          Math.atan(Math.tan(toRadians(horizontalFovDeg) / 2) / viewportAspect),
      ),
    };
  }
  return {
    horizontalFovDeg: toDegrees(
      2 * Math.atan(Math.tan(toRadians(verticalFovDeg) / 2) * viewportAspect),
    ),
    verticalFovDeg,
  };
}

export function containAwareFov(
  horizontalFovDeg: number,
  verticalFovDeg: number,
  imageAspect: number,
  viewportAspect: number,
) {
  if (
    [horizontalFovDeg, verticalFovDeg, imageAspect, viewportAspect].some(
      (value) => value <= 0,
    )
  )
    throw new Error("FOV and aspect ratios must be positive.");
  if (viewportAspect > imageAspect) {
    return {
      horizontalFovDeg: toDegrees(
        2 * Math.atan(Math.tan(toRadians(verticalFovDeg) / 2) * viewportAspect),
      ),
      verticalFovDeg,
    };
  }
  return {
    horizontalFovDeg,
    verticalFovDeg: toDegrees(
      2 * Math.atan(Math.tan(toRadians(horizontalFovDeg) / 2) / viewportAspect),
    ),
  };
}

export function cameraDirectionEnu(headingDeg: number, pitchDeg: number): Vec3 {
  const heading = toRadians(headingDeg);
  const pitch = toRadians(pitchDeg);
  const horizontal = Math.cos(pitch);
  return {
    x: Math.sin(heading) * horizontal,
    y: Math.cos(heading) * horizontal,
    z: Math.sin(pitch),
  };
}

export function geodeticToEcef(position: GeoPosition): Vec3 {
  const latitude = toRadians(position.latitude);
  const longitude = toRadians(position.longitude);
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const normal = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    x: (normal + position.altitudeM) * cosLat * Math.cos(longitude),
    y: (normal + position.altitudeM) * cosLat * Math.sin(longitude),
    z: (normal * (1 - WGS84_E2) + position.altitudeM) * sinLat,
  };
}

export function enuToEcefVector(vector: Vec3, origin: GeoPosition): Vec3 {
  const latitude = toRadians(origin.latitude);
  const longitude = toRadians(origin.longitude);
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinLon = Math.sin(longitude);
  const cosLon = Math.cos(longitude);
  return {
    x:
      -sinLon * vector.x -
      sinLat * cosLon * vector.y +
      cosLat * cosLon * vector.z,
    y:
      cosLon * vector.x -
      sinLat * sinLon * vector.y +
      cosLat * sinLon * vector.z,
    z: cosLat * vector.y + sinLat * vector.z,
  };
}

export function frustumCorners(
  horizontalFovDeg: number,
  verticalFovDeg: number,
  nearM: number,
  farM: number,
): Vec3[] {
  if (nearM <= 0 || farM <= nearM) throw new Error("Invalid frustum range.");
  const halfWidth = (distance: number) =>
    Math.tan(toRadians(horizontalFovDeg) / 2) * distance;
  const halfHeight = (distance: number) =>
    Math.tan(toRadians(verticalFovDeg) / 2) * distance;
  return [nearM, farM].flatMap((distance) => {
    const width = halfWidth(distance);
    const height = halfHeight(distance);
    return [
      { x: -width, y: height, z: distance },
      { x: width, y: height, z: distance },
      { x: width, y: -height, z: distance },
      { x: -width, y: -height, z: distance },
    ];
  });
}
