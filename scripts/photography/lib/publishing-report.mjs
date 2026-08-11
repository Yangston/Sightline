export function buildPhotographyPublishingReport({
  ids,
  manifest,
  pilots,
  rejections,
  skippedIds = new Set(),
}) {
  const manifestIds = new Set(manifest.map((item) => item.id));
  const pilotById = new Map(pilots.map((item) => [item.id, item]));
  const rejectionById = new Map(rejections.map((item) => [item.id, item]));
  return ids.map((id) => {
    const pilot = pilotById.get(id);
    const rejection = rejectionById.get(id);
    const mapPublished = Boolean(
      pilot?.automaticEvidence?.overlayAudit && !rejection,
    );
    const mapStatus = mapPublished
      ? "accepted"
      : rejection
        ? "rejected"
        : skippedIds.has(id)
          ? "skipped"
          : "rejected";
    return {
      id,
      cityId: pilot?.cityId ?? rejection?.cityId,
      galleryPublished: manifestIds.has(id),
      mapStatus,
      mapPublished,
      candidateVisible: Boolean(rejection?.cameraCandidate),
      rejectionReasons:
        rejection?.rejectionReasons ??
        (skippedIds.has(id) ? ["automatic-calibration-unavailable"] : []),
      ...(!mapPublished
        ? {
            retryCommand: `npm run photos -- --calibrate-ids=${id} --replace-calibration`,
          }
        : {}),
    };
  });
}

export function photographyPublishingExitCode(report) {
  return report.some((item) => !item.galleryPublished) ? 1 : 0;
}
