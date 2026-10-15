export function finalizeOverlayResult(result) {
  const repairAccepted =
    result.repair?.written === true &&
    result.repair.overlay?.status === "accepted" &&
    result.repair.frustumDepth?.accepted === true;
  if (!repairAccepted) return result;

  const finalized = {
    ...result,
    initialStatus: result.status,
    ...(result.reason ? { initialReason: result.reason } : {}),
    status: "accepted",
  };
  delete finalized.reason;
  return finalized;
}
