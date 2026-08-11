const SOURCES = new Set(["exif", "estimated", "manual", "computer-vision"]);

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function boundedNumber(value, minimum, maximum) {
  const number = finiteNumber(value);
  return number !== undefined && number >= minimum && number <= maximum
    ? number
    : undefined;
}

function confidenceFrom(value, metrics) {
  const authored = boundedNumber(value, 0, 1);
  if (authored !== undefined) return authored;
  const inlierRatio = boundedNumber(metrics?.inlierRatio, 0, 1) ?? 0;
  const imageCoverage = boundedNumber(metrics?.imageCoverage, 0, 1) ?? 0;
  return Math.min(0.99, 0.55 + inlierRatio * 0.25 + imageCoverage * 0.2);
}

function fovFrom35mm(focalLength35Mm, width, height) {
  if (
    !finiteNumber(focalLength35Mm) ||
    !finiteNumber(width) ||
    !finiteNumber(height) ||
    focalLength35Mm <= 0 ||
    width <= 0 ||
    height <= 0
  )
    return { horizontalFovDeg: 55, verticalFovDeg: 42 };
  const diagonal = Math.hypot(36, 24);
  const imageDiagonal = Math.hypot(width, height);
  const sensorWidth = (diagonal * width) / imageDiagonal;
  const sensorHeight = (diagonal * height) / imageDiagonal;
  return {
    horizontalFovDeg:
      (2 * Math.atan(sensorWidth / (2 * focalLength35Mm)) * 180) / Math.PI,
    verticalFovDeg:
      (2 * Math.atan(sensorHeight / (2 * focalLength35Mm)) * 180) / Math.PI,
  };
}

export function sanitizeCameraCandidate(candidate) {
  const position =
    candidate?.position ?? candidate?.corrected ?? candidate?.location;
  const pose = candidate?.pose ?? candidate;
  const optics = candidate?.optics ?? candidate;
  const frustum = candidate?.frustum ?? candidate;
  const latitude = boundedNumber(position?.latitude, -90, 90);
  const longitude = boundedNumber(position?.longitude, -180, 180);
  const altitudeM = boundedNumber(position?.altitudeM, -500, 20_000);
  const headingDeg = boundedNumber(pose?.headingDeg, 0, 360);
  const pitchDeg = boundedNumber(pose?.pitchDeg, -90, 90);
  const rollDeg = boundedNumber(pose?.rollDeg, -180, 180);
  const horizontalFovDeg = boundedNumber(optics?.horizontalFovDeg, 1, 179);
  const verticalFovDeg = boundedNumber(optics?.verticalFovDeg, 1, 179);
  const nearM = finiteNumber(frustum?.nearM);
  const farM = finiteNumber(frustum?.farM);
  const source = SOURCES.has(candidate?.source)
    ? candidate.source
    : "computer-vision";

  if (
    [
      latitude,
      longitude,
      altitudeM,
      headingDeg,
      pitchDeg,
      rollDeg,
      horizontalFovDeg,
      verticalFovDeg,
      nearM,
      farM,
    ].some((value) => value === undefined) ||
    nearM <= 0 ||
    farM <= nearM
  )
    return undefined;

  return {
    position: { latitude, longitude, altitudeM },
    headingDeg,
    pitchDeg,
    rollDeg,
    horizontalFovDeg,
    verticalFovDeg,
    nearM,
    farM,
    confidence: confidenceFrom(candidate?.confidence, candidate?.metrics),
    source,
  };
}

export function cameraCandidateFromSolved(solved) {
  return sanitizeCameraCandidate({
    ...solved,
    source: "computer-vision",
    metrics: solved?.metrics,
  });
}

export function cameraCandidateFromSeed(seed) {
  return sanitizeCameraCandidate({
    ...seed,
    position: seed?.corrected ?? seed?.location,
    frustum: { nearM: seed?.nearM, farM: seed?.farM },
  });
}

export function cameraCandidateFromExactMetadata(metadata, geoidUndulationM) {
  if (!metadata?.gps || !finiteNumber(geoidUndulationM)) return undefined;
  const optics = fovFrom35mm(
    metadata.focalLength35Mm,
    metadata.width,
    metadata.height,
  );
  return sanitizeCameraCandidate({
    position: {
      latitude: metadata.gps.latitude,
      longitude: metadata.gps.longitude,
      altitudeM: metadata.gps.altitudeM + geoidUndulationM,
    },
    headingDeg: metadata.headingDeg,
    pitchDeg: metadata.pitchDeg,
    rollDeg: metadata.rollDeg,
    ...optics,
    nearM: 1,
    farM: 500,
    confidence: 0.35,
    source: "exif",
  });
}

export function cameraCandidateFromOverlayResult(result, seed) {
  return (
    sanitizeCameraCandidate({
      ...result?.repair,
      frustum: result?.repair?.frustumDepth?.frustum ?? result?.repair?.frustum,
      source: "computer-vision",
      metrics: result?.repair?.metrics,
    }) ?? cameraCandidateFromSeed(seed)
  );
}
