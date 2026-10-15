import { cameraDirectionEnu, geodeticToEcef, type Vec3 } from "./math";
import type { GeoPosition } from "./types";

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

export type CalibrationControlPoint = {
  image: { xPx: number; yPx: number };
  world: GeoPosition;
};

export type CalibrationCamera = {
  position: GeoPosition;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  horizontalFovDeg: number;
  verticalFovDeg: number;
  imageWidth: number;
  imageHeight: number;
};

export type CalibrationSolution = CalibrationCamera & {
  rmsErrorPx: number;
  iterations: number;
};

export type CalibrationRefinementOptions = {
  maxIterations?: number;
  horizontalPriorSigmaM?: number;
  altitudePriorSigmaM?: number;
  fovPriorScaleSigma?: number;
};

export type OrientationRefinementOptions = {
  maxIterations?: number;
  optimizeRoll?: boolean;
};

export function containedImagePoint(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number,
  localX: number,
  localY: number,
) {
  if (
    [containerWidth, containerHeight, imageWidth, imageHeight].some(
      (value) => value <= 0,
    )
  )
    throw new Error("Image and container dimensions must be positive.");
  const scale = Math.min(
    containerWidth / imageWidth,
    containerHeight / imageHeight,
  );
  const renderedWidth = imageWidth * scale;
  const renderedHeight = imageHeight * scale;
  const offsetX = (containerWidth - renderedWidth) / 2;
  const offsetY = (containerHeight - renderedHeight) / 2;
  if (
    localX < offsetX ||
    localX > offsetX + renderedWidth ||
    localY < offsetY ||
    localY > offsetY + renderedHeight
  )
    return undefined;
  return {
    xPx: (localX - offsetX) / scale,
    yPx: (localY - offsetY) / scale,
  };
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

function normalize(vector: Vec3): Vec3 {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (magnitude < 1e-12) throw new Error("Camera basis is degenerate.");
  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
    z: vector.z / magnitude,
  };
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function ecefDeltaToEnu(delta: Vec3, origin: GeoPosition): Vec3 {
  const latitude = toRadians(origin.latitude);
  const longitude = toRadians(origin.longitude);
  const east = {
    x: -Math.sin(longitude),
    y: Math.cos(longitude),
    z: 0,
  };
  const north = {
    x: -Math.sin(latitude) * Math.cos(longitude),
    y: -Math.sin(latitude) * Math.sin(longitude),
    z: Math.cos(latitude),
  };
  const up = {
    x: Math.cos(latitude) * Math.cos(longitude),
    y: Math.cos(latitude) * Math.sin(longitude),
    z: Math.sin(latitude),
  };
  return { x: dot(delta, east), y: dot(delta, north), z: dot(delta, up) };
}

function scaleFov(fovDeg: number, scale: number) {
  return toDegrees(2 * Math.atan(Math.tan(toRadians(fovDeg) / 2) * scale));
}

export function projectWorldPoint(
  camera: CalibrationCamera,
  world: GeoPosition,
) {
  const cameraEcef = geodeticToEcef(camera.position);
  const worldEcef = geodeticToEcef(world);
  const point = ecefDeltaToEnu(
    subtract(worldEcef, cameraEcef),
    camera.position,
  );
  const direction = normalize(
    cameraDirectionEnu(camera.headingDeg, camera.pitchDeg),
  );
  const levelUp = { x: 0, y: 0, z: 1 };
  const baseRight = normalize(cross(direction, levelUp));
  const baseUp = normalize(cross(baseRight, direction));
  const roll = toRadians(camera.rollDeg);
  const right = {
    x: baseRight.x * Math.cos(roll) - baseUp.x * Math.sin(roll),
    y: baseRight.y * Math.cos(roll) - baseUp.y * Math.sin(roll),
    z: baseRight.z * Math.cos(roll) - baseUp.z * Math.sin(roll),
  };
  const up = {
    x: baseRight.x * Math.sin(roll) + baseUp.x * Math.cos(roll),
    y: baseRight.y * Math.sin(roll) + baseUp.y * Math.cos(roll),
    z: baseRight.z * Math.sin(roll) + baseUp.z * Math.cos(roll),
  };
  const depth = dot(point, direction);
  if (depth <= 0) return undefined;
  const focalX =
    camera.imageWidth / (2 * Math.tan(toRadians(camera.horizontalFovDeg) / 2));
  const focalY =
    camera.imageHeight / (2 * Math.tan(toRadians(camera.verticalFovDeg) / 2));
  return {
    xPx: camera.imageWidth / 2 + (focalX * dot(point, right)) / depth,
    yPx: camera.imageHeight / 2 - (focalY * dot(point, up)) / depth,
    depthM: depth,
  };
}

export function reprojectionRmsPx(
  camera: CalibrationCamera,
  points: CalibrationControlPoint[],
) {
  if (!points.length) return Number.POSITIVE_INFINITY;
  let squaredError = 0;
  for (const point of points) {
    const projected = projectWorldPoint(camera, point.world);
    if (!projected) return Number.POSITIVE_INFINITY;
    squaredError +=
      (projected.xPx - point.image.xPx) ** 2 +
      (projected.yPx - point.image.yPx) ** 2;
  }
  return Math.sqrt(squaredError / points.length);
}

function normalizedHeading(headingDeg: number) {
  return ((headingDeg % 360) + 360) % 360;
}

export function refineOrientationFromControlPoints(
  initial: CalibrationCamera,
  points: CalibrationControlPoint[],
  options: OrientationRefinementOptions = {},
): CalibrationSolution {
  if (!points.length)
    throw new Error(
      "At least one 2D-to-3D control point is required for orientation refinement.",
    );

  type Parameters = {
    headingDeg: number;
    pitchDeg: number;
    rollDeg: number;
  };
  let current: Parameters = {
    headingDeg: initial.headingDeg,
    pitchDeg: initial.pitchDeg,
    rollDeg: initial.rollDeg,
  };
  const steps: Record<keyof Parameters, number> = {
    headingDeg: 1,
    pitchDeg: 1,
    rollDeg: 0.5,
  };
  const minimumSteps: Record<keyof Parameters, number> = {
    headingDeg: 0.001,
    pitchDeg: 0.001,
    rollDeg: 0.001,
  };
  const keys: (keyof Parameters)[] = options.optimizeRoll
    ? ["headingDeg", "pitchDeg", "rollDeg"]
    : ["headingDeg", "pitchDeg"];
  const cameraFrom = (parameters: Parameters): CalibrationCamera => ({
    ...initial,
    headingDeg: normalizedHeading(parameters.headingDeg),
    pitchDeg: parameters.pitchDeg,
    rollDeg: parameters.rollDeg,
  });
  const score = (parameters: Parameters) =>
    reprojectionRmsPx(cameraFrom(parameters), points);

  let bestScore = score(current);
  let iterations = 0;
  const maxIterations = options.maxIterations ?? 100;
  for (; iterations < maxIterations; iterations += 1) {
    let improved = false;
    for (const key of keys) {
      for (const direction of [-1, 1]) {
        const candidate = {
          ...current,
          [key]: current[key] + direction * steps[key],
        };
        if (candidate.pitchDeg <= -89 || candidate.pitchDeg >= 89) continue;
        const candidateScore = score(candidate);
        if (candidateScore < bestScore) {
          current = candidate;
          bestScore = candidateScore;
          improved = true;
        }
      }
    }
    if (!improved) {
      let finished = true;
      for (const key of keys) {
        steps[key] /= 2;
        if (steps[key] > minimumSteps[key]) finished = false;
      }
      if (finished) break;
    }
  }
  const camera = cameraFrom(current);
  return {
    ...camera,
    rmsErrorPx: reprojectionRmsPx(camera, points),
    iterations,
  };
}

function horizontalDistanceM(a: GeoPosition, b: GeoPosition) {
  const latitudeM = (a.latitude - b.latitude) * 111_320;
  const longitudeM =
    (a.longitude - b.longitude) *
    111_320 *
    Math.cos(toRadians((a.latitude + b.latitude) / 2));
  return Math.hypot(latitudeM, longitudeM);
}

export function refineCameraFromControlPoints(
  initial: CalibrationCamera,
  points: CalibrationControlPoint[],
  options: CalibrationRefinementOptions = {},
): CalibrationSolution {
  if (points.length < 4)
    throw new Error("At least four 2D-to-3D control points are required.");

  type Parameters = {
    latitude: number;
    longitude: number;
    altitudeM: number;
    headingDeg: number;
    pitchDeg: number;
    rollDeg: number;
    fovScale: number;
  };
  const starting: Parameters = {
    ...initial.position,
    headingDeg: initial.headingDeg,
    pitchDeg: initial.pitchDeg,
    rollDeg: initial.rollDeg,
    fovScale: 1,
  };
  const maxIterations = options.maxIterations ?? 120;
  const horizontalPriorSigmaM = options.horizontalPriorSigmaM ?? 12;
  const altitudePriorSigmaM = options.altitudePriorSigmaM ?? 25;
  const fovPriorScaleSigma = options.fovPriorScaleSigma ?? 0.08;
  let current = { ...starting };
  const steps: Record<keyof Parameters, number> = {
    latitude: 0.00002,
    longitude: 0.00002,
    altitudeM: 2,
    headingDeg: 1,
    pitchDeg: 1,
    rollDeg: 0.5,
    fovScale: 0.02,
  };
  const minimumSteps: Record<keyof Parameters, number> = {
    latitude: 0.00000002,
    longitude: 0.00000002,
    altitudeM: 0.01,
    headingDeg: 0.01,
    pitchDeg: 0.01,
    rollDeg: 0.01,
    fovScale: 0.0002,
  };

  const cameraFrom = (parameters: Parameters): CalibrationCamera => ({
    ...initial,
    position: {
      latitude: parameters.latitude,
      longitude: parameters.longitude,
      altitudeM: parameters.altitudeM,
    },
    headingDeg: normalizedHeading(parameters.headingDeg),
    pitchDeg: parameters.pitchDeg,
    rollDeg: parameters.rollDeg,
    horizontalFovDeg: scaleFov(initial.horizontalFovDeg, parameters.fovScale),
    verticalFovDeg: scaleFov(initial.verticalFovDeg, parameters.fovScale),
  });

  const score = (parameters: Parameters) => {
    const camera = cameraFrom(parameters);
    const rms = reprojectionRmsPx(camera, points);
    if (!Number.isFinite(rms)) return Number.POSITIVE_INFINITY;
    const horizontalPrior = horizontalDistanceM(
      camera.position,
      initial.position,
    );
    const altitudePrior =
      camera.position.altitudeM - initial.position.altitudeM;
    const fovPrior = (parameters.fovScale - 1) / fovPriorScaleSigma;
    return (
      rms ** 2 +
      (horizontalPrior / horizontalPriorSigmaM) ** 2 * 25 +
      (altitudePrior / altitudePriorSigmaM) ** 2 * 25 +
      fovPrior ** 2 * 25
    );
  };

  let bestScore = score(current);
  let iterations = 0;
  const keys = Object.keys(steps) as (keyof Parameters)[];
  for (; iterations < maxIterations; iterations += 1) {
    let improved = false;
    for (const key of keys) {
      for (const direction of [-1, 1]) {
        const candidate = {
          ...current,
          [key]: current[key] + direction * steps[key],
        };
        if (candidate.fovScale <= 0.5 || candidate.fovScale >= 1.5) continue;
        const candidateScore = score(candidate);
        if (candidateScore < bestScore) {
          current = candidate;
          bestScore = candidateScore;
          improved = true;
        }
      }
    }
    if (!improved) {
      let finished = true;
      for (const key of keys) {
        steps[key] /= 2;
        if (steps[key] > minimumSteps[key]) finished = false;
      }
      if (finished) break;
    }
  }
  const camera = cameraFrom(current);
  return {
    ...camera,
    rmsErrorPx: reprojectionRmsPx(camera, points),
    iterations,
  };
}
