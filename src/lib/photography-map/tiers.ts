import type { CalibrationStatus, RenderingTier } from "./types";

export type TierCapabilities = {
  webgl: boolean;
  googleKey: boolean;
  ionToken: boolean;
  mobile: boolean;
  saveData: boolean;
  photorealisticCoverage: "expected" | "verified" | "unsupported" | "unknown";
  osmCoverage: "expected" | "verified" | "unsupported" | "unknown";
  hasLocation: boolean;
  hasPose: boolean;
  calibration: CalibrationStatus;
};

export function selectRenderingTier(
  capabilities: TierCapabilities,
): RenderingTier {
  if (!capabilities.webgl)
    return capabilities.hasLocation ? "marker" : "gallery";
  if (!capabilities.hasLocation) return "gallery";
  if (capabilities.mobile || capabilities.saveData)
    return capabilities.hasPose ? "terrain" : "marker";
  if (
    capabilities.googleKey &&
    capabilities.photorealisticCoverage !== "unsupported"
  )
    return "photorealistic";
  const calibrated = capabilities.calibration === "calibrated";
  if (
    calibrated &&
    capabilities.ionToken &&
    !["unknown", "unsupported"].includes(capabilities.osmCoverage)
  )
    return "osm-buildings";
  if (capabilities.hasPose) return "terrain";
  return "marker";
}

export const tierOrder: RenderingTier[] = [
  "photorealistic",
  "osm-buildings",
  "terrain",
  "marker",
  "gallery",
];

export function nextSimplerTier(current: RenderingTier): RenderingTier {
  return tierOrder[
    Math.min(tierOrder.indexOf(current) + 1, tierOrder.length - 1)
  ];
}
