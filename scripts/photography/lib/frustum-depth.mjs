export function providerDepthOverridesSolvedRange({
  previousNearM,
  previousFarM,
  providerP98M,
  validDepthRatio,
  secondaryDepthCount = 0,
}) {
  if (
    !Number.isFinite(previousNearM) ||
    !Number.isFinite(previousFarM) ||
    !Number.isFinite(providerP98M) ||
    providerP98M <= 0
  )
    return false;
  const providerHasCoverage = validDepthRatio >= 0.75;
  const providerHasUnoccludedRange =
    providerP98M >= 30 || secondaryDepthCount >= 8;
  const solvedRangeIsGrosslyInflated = previousFarM / providerP98M >= 10;
  return (
    previousNearM >= 50 &&
    providerHasCoverage &&
    providerHasUnoccludedRange &&
    solvedRangeIsGrosslyInflated
  );
}

export function providerDepthMissesSolvedSurfaces({
  previousFarM,
  providerP02M,
  providerP50M,
}) {
  if (
    !Number.isFinite(previousFarM) ||
    !Number.isFinite(providerP02M) ||
    !Number.isFinite(providerP50M) ||
    previousFarM <= 0
  )
    return false;
  return (
    providerP02M > previousFarM * 1.25 && providerP50M > previousFarM * 1.5
  );
}

export function providerDepthTruncatesTrustedRange({
  previousNearM,
  previousFarM,
  providerP98M,
  providerOverridesConflict,
}) {
  if (
    providerOverridesConflict ||
    !Number.isFinite(previousNearM) ||
    !Number.isFinite(previousFarM) ||
    !Number.isFinite(providerP98M) ||
    providerP98M <= 0
  )
    return false;
  return previousFarM / providerP98M >= 3 && previousNearM >= 50;
}
