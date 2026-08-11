function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * fraction)),
  );
  return sorted[index];
}

export function normalizedOverlayResidual({
  queryPoints,
  referencePoints,
  querySize,
  referenceSize,
}) {
  const count = Math.min(queryPoints.length, referencePoints.length);
  const residuals = Array.from({ length: count }, (_, index) => {
    const [queryX, queryY] = queryPoints[index];
    const [referenceX, referenceY] = referencePoints[index];
    return Math.hypot(
      queryX / querySize.width - referenceX / referenceSize.width,
      queryY / querySize.height - referenceY / referenceSize.height,
    );
  });
  if (!count)
    return {
      matchCount: 0,
      imageCoverage: 0,
      medianDeltaX: null,
      medianDeltaY: null,
      medianRadialScale: null,
      medianRotationDeg: null,
      medianResidual: null,
      p90Residual: null,
      maximumResidual: null,
    };
  const normalizedQuery = queryPoints
    .slice(0, count)
    .map(([x, y]) => [x / querySize.width, y / querySize.height]);
  const normalizedReference = referencePoints
    .slice(0, count)
    .map(([x, y]) => [x / referenceSize.width, y / referenceSize.height]);
  const xs = normalizedQuery.map(([x]) => x);
  const ys = normalizedQuery.map(([, y]) => y);
  const deltaX = normalizedQuery.map(
    ([queryX], index) => normalizedReference[index][0] - queryX,
  );
  const deltaY = normalizedQuery.map(
    ([, queryY], index) => normalizedReference[index][1] - queryY,
  );
  const medianDeltaX = percentile(deltaX, 0.5);
  const medianDeltaY = percentile(deltaY, 0.5);
  const radialScales = [];
  const rotations = [];
  for (let index = 0; index < count; index += 1) {
    const [queryX, queryY] = normalizedQuery[index];
    const [referenceX, referenceY] = normalizedReference[index];
    const queryCentered = [queryX - 0.5, queryY - 0.5];
    const referenceCentered = [
      referenceX - medianDeltaX - 0.5,
      referenceY - medianDeltaY - 0.5,
    ];
    const queryRadius = Math.hypot(...queryCentered);
    const referenceRadius = Math.hypot(...referenceCentered);
    if (queryRadius < 0.03 || referenceRadius < 0.03) continue;
    radialScales.push(referenceRadius / queryRadius);
    let angle =
      (Math.atan2(referenceCentered[1], referenceCentered[0]) -
        Math.atan2(queryCentered[1], queryCentered[0])) *
      (180 / Math.PI);
    while (angle > 180) angle -= 360;
    while (angle < -180) angle += 360;
    rotations.push(angle);
  }
  return {
    matchCount: count,
    imageCoverage:
      (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)),
    medianDeltaX,
    medianDeltaY,
    medianRadialScale: percentile(radialScales, 0.5),
    medianRotationDeg: percentile(rotations, 0.5),
    medianResidual: percentile(residuals, 0.5),
    p90Residual: percentile(residuals, 0.9),
    maximumResidual: Math.max(...residuals),
  };
}

export function classifyOverlayResidual(metrics) {
  if (
    metrics.matchCount >= 8 &&
    metrics.imageCoverage >= 0.01 &&
    metrics.medianResidual > 0.12
  )
    return { status: "rejected", reason: "gross-screen-misalignment" };
  if (metrics.matchCount < 12)
    return { status: "inconclusive", reason: "too-few-geometric-inliers" };
  if (metrics.imageCoverage < 0.01)
    return { status: "inconclusive", reason: "poor-image-coverage" };
  if (metrics.medianResidual > 0.04)
    return { status: "rejected", reason: "large-median-screen-residual" };
  if (metrics.p90Residual > 0.1)
    return { status: "rejected", reason: "large-tail-screen-residual" };
  return { status: "accepted" };
}

export function providerRenderStatsUsable(stats) {
  const dynamicChannels = stats.channels.filter(
    (channel) => channel.max - channel.min >= 12 && channel.stdev >= 2,
  );
  return stats.entropy >= 0.5 && dynamicChannels.length >= 2;
}

export function overlayRunCanMutate(results) {
  return (
    results.length > 0 &&
    !results.every((result) => result.reason === "provider-render-unavailable")
  );
}
