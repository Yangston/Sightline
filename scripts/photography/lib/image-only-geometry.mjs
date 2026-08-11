import { createHash } from "node:crypto";

const EARTH_RADIUS_M = 6_378_137;

export function haversineDistanceM(left, right) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const latitude1 = radians(left.latitude);
  const latitude2 = radians(right.latitude);
  const chord =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(chord)));
}

export function createCoordinateLattice(bounds, spacingM) {
  if (
    !bounds ||
    bounds.west >= bounds.east ||
    bounds.south >= bounds.north ||
    !Number.isFinite(spacingM) ||
    spacingM <= 0
  )
    throw new Error("A coordinate lattice requires valid bounds and spacing.");
  const centerLatitude = (bounds.south + bounds.north) / 2;
  const latitudeStep = spacingM / 111_320;
  const longitudeStep =
    spacingM / (111_320 * Math.cos((centerLatitude * Math.PI) / 180));
  const coordinates = [];
  for (
    let latitude = bounds.south;
    latitude <= bounds.north + latitudeStep / 4;
    latitude += latitudeStep
  )
    for (
      let longitude = bounds.west;
      longitude <= bounds.east + longitudeStep / 4;
      longitude += longitudeStep
    )
      coordinates.push({
        latitude: Math.min(bounds.north, latitude),
        longitude: Math.min(bounds.east, longitude),
      });
  return coordinates;
}

export function suppressSpatialNearTies(
  scoredCoordinates,
  { primaryLimit, fallbackLimit, suppressionRadiusM },
) {
  const selected = [];
  for (const candidate of [...scoredCoordinates].sort(
    (left, right) => right.score - left.score,
  )) {
    if (
      selected.every(
        (existing) =>
          haversineDistanceM(existing, candidate) >= suppressionRadiusM,
      )
    )
      selected.push(candidate);
    if (selected.length >= primaryLimit + fallbackLimit) break;
  }
  return {
    primary: selected.slice(0, primaryLimit),
    fallback: selected.slice(primaryLimit, primaryLimit + fallbackLimit),
  };
}

export function insideBounds(position, bounds) {
  return (
    position.longitude >= bounds.west &&
    position.longitude <= bounds.east &&
    position.latitude >= bounds.south &&
    position.latitude <= bounds.north
  );
}

export function circularDifferenceDeg(left, right) {
  return Math.abs(((((left - right + 540) % 360) + 360) % 360) - 180);
}

export function validateImageOnlySolution({
  solved,
  panoramaPosition,
  bounds,
  maximumPanoramaDistanceM,
  competingSolutions = /** @type {Array<{
    accepted?: boolean;
    position?: { latitude: number; longitude: number; altitudeM?: number };
    metrics?: { inliers?: number; rmsErrorPx?: number };
  }>} */ ([]),
}) {
  const reasons = [];
  if (!solved?.accepted || solved.solutionMode !== "absolute-pose")
    reasons.push("absolute-pose-required");
  if (solved?.position && !insideBounds(solved.position, bounds))
    reasons.push("solved-center-outside-experiment-bounds");
  if (
    solved?.position &&
    panoramaPosition &&
    haversineDistanceM(solved.position, panoramaPosition) >
      maximumPanoramaDistanceM
  )
    reasons.push("solved-center-too-far-from-panorama");
  const acceptedCompetitors = competingSolutions.filter(
    (candidate) => candidate.accepted && candidate.position,
  );
  if (
    solved?.position &&
    acceptedCompetitors.some(
      (candidate) =>
        haversineDistanceM(solved.position, candidate.position) >= 300 &&
        Math.abs(
          (candidate.metrics?.inliers ?? 0) - (solved.metrics?.inliers ?? 0),
        ) <= 3 &&
        Math.abs(
          (candidate.metrics?.rmsErrorPx ?? Number.POSITIVE_INFINITY) -
            (solved.metrics?.rmsErrorPx ?? Number.POSITIVE_INFINITY),
        ) <= 1,
    )
  )
    reasons.push("geographically-distant-near-tie");
  return { accepted: reasons.length === 0, rejectionReasons: reasons };
}

export function sealPrediction(prediction) {
  const canonical = JSON.stringify(sortObject(prediction));
  return createHash("sha256").update(canonical).digest("hex");
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortObject(item)]),
  );
}
