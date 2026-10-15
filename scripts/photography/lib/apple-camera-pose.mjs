const toDegrees = (radians) => (radians * 180) / Math.PI;

function normalizeSignedDegrees(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

export function parseAccelerationVector(value) {
  if (typeof value !== "string") return undefined;
  const components = value.trim().split(/\s+/).map(Number);
  if (
    components.length !== 3 ||
    components.some((component) => !Number.isFinite(component))
  )
    return undefined;
  const [x, y, z] = components;
  return { x, y, z };
}

export function poseFromAccelerationVector(vector) {
  if (!vector) return undefined;
  const planarMagnitude = Math.hypot(vector.x, vector.y);
  if (planarMagnitude < 0.5) return undefined;

  // Apple stores specific force in phone coordinates. ExifTool documents
  // positive X toward the phone's left edge, positive Y toward its bottom,
  // and positive Z through the rear camera. Removing the nearest 90-degree
  // device orientation leaves the photographed horizon roll.
  const deviceAngleDeg = toDegrees(Math.atan2(vector.x, -vector.y));
  const nearestOrientationDeg = Math.round(deviceAngleDeg / 90) * 90;
  return {
    pitchDeg: toDegrees(Math.atan2(vector.z, planarMagnitude)),
    rollDeg: normalizeSignedDegrees(deviceAngleDeg - nearestOrientationDeg),
  };
}
