import { z } from "zod";
import { cameraCandidateSchema } from "./schema";
import type {
  CalibrationStatus,
  CameraCandidate,
  GeoPosition,
  RenderingTier,
} from "./types";
import automaticPilotJson from "@/data/photography-auto-pilots.json";
import automaticRejectionJson from "@/data/photography-auto-rejections.json";

export type PilotSeed = {
  id: string;
  cityId: string;
  country: string;
  location: GeoPosition;
  originalAltitudeReference?:
    "ellipsoid" | "mean-sea-level" | "terrain" | "unknown";
  geoidUndulationM?: number;
  horizontalAccuracyM?: number;
  headingDeg: number;
  pitchDeg?: number;
  rollDeg?: number;
  focalLengthMm?: number;
  focalLength35Mm?: number;
  horizontalFovDeg?: number;
  verticalFovDeg?: number;
  source?: "exif" | "estimated" | "manual" | "computer-vision";
  confidence: number;
  calibration: CalibrationStatus;
  presentation?: "hero" | "standard" | "unsupported";
  preferredTier?: RenderingTier;
  highlightApproved?: boolean;
  highlightMode?: "projective-texture" | "tint";
  farM?: number;
  nearM?: number;
  alt?: string;
  corrected?: GeoPosition;
  automaticEvidence?: {
    matcher: string;
    matches: number;
    inliers: number;
    inlierRatio: number;
    rmsErrorPx: number | null;
    angularRmsDeg?: number;
    imageCoverage: number;
    positionDeltaM: number | null;
    referenceView: string;
    solutionMode?:
      | "absolute-pose"
      | "orientation-with-gps-prior"
      | "bearing-rotation-with-gps-prior";
    frustumDepth?: {
      accepted: boolean;
      method: "full-frame-provider-depth-grid";
      columns?: number;
      rows?: number;
      sampleCount?: number;
      validDepthCount?: number;
      validDepthRatio?: number;
      nonCityDepthCount?: number;
      percentilesM?: {
        p02: number;
        p05: number;
        p50: number;
        p95: number;
        p98: number;
      };
      frustum?: { nearM: number; farM: number };
      rejectionReason?: string;
      error?: string;
    };
    overlayAudit?: {
      matcher: string;
      geometricInliers: number;
      imageCoverage: number;
      medianResidual: number;
      p90Residual: number;
    };
  };
};

export type AutomaticRejection = {
  id: string;
  cityId: string;
  rejectionReasons: string[];
  cameraCandidate?: CameraCandidate;
};

const automaticRejectionSchema = z.object({
  id: z.string().min(1),
  cityId: z.string().min(1),
  rejectionReasons: z.array(z.string().min(1)).min(1),
  cameraCandidate: cameraCandidateSchema.optional(),
});

const exifMeanSeaLevel = (
  geoidUndulationM: number,
  horizontalAccuracyM: number,
) => ({
  originalAltitudeReference: "mean-sea-level" as const,
  geoidUndulationM,
  horizontalAccuracyM,
});

export const authoredPilotSeeds: PilotSeed[] = [
  {
    id: "img-7492",
    cityId: "san-francisco",
    country: "united-states",
    location: { latitude: 37.799153, longitude: -122.419053, altitudeM: 80.99 },
    ...exifMeanSeaLevel(-32.225, 10.42),
    headingDeg: 247.2,
    pitchDeg: 1.92,
    rollDeg: -0.89,
    focalLengthMm: 6.8,
    focalLength35Mm: 48,
    confidence: 0.76,
    calibration: "approximate",
    presentation: "hero",
    preferredTier: "photorealistic",
    highlightApproved: false,
    farM: 110,
    alt: "Swensen's ice cream storefront glowing at a San Francisco intersection at night.",
  },
  {
    id: "img-7498",
    cityId: "san-francisco",
    country: "united-states",
    location: { latitude: 37.796978, longitude: -122.4134, altitudeM: 71.74 },
    ...exifMeanSeaLevel(-32.22, 17.1),
    headingDeg: 79.43,
    pitchDeg: -0.77,
    rollDeg: -2.39,
    focalLengthMm: 6.8,
    focalLength35Mm: 48,
    confidence: 0.67,
    calibration: "approximate",
    farM: 4_000,
    alt: "A steep San Francisco street descending toward the Bay Bridge.",
  },
  {
    id: "img-7526",
    cityId: "san-francisco",
    country: "united-states",
    location: { latitude: 37.788233, longitude: -122.439933, altitudeM: 54.68 },
    ...exifMeanSeaLevel(-32.257, 14.25),
    headingDeg: 171.01,
    pitchDeg: 11.58,
    rollDeg: 0.17,
    focalLengthMm: 6.8,
    focalLength35Mm: 24,
    confidence: 0.76,
    calibration: "approximate",
    presentation: "hero",
    preferredTier: "photorealistic",
    highlightApproved: false,
    farM: 85,
    alt: "Ornate Victorian facades across a San Francisco street.",
  },
  {
    id: "img-7532",
    cityId: "san-francisco",
    country: "united-states",
    location: { latitude: 37.794589, longitude: -122.433297, altitudeM: 79.37 },
    ...exifMeanSeaLevel(-32.244, 14.25),
    headingDeg: 346.95,
    pitchDeg: -3.16,
    rollDeg: -0.85,
    focalLengthMm: 6.8,
    focalLength35Mm: 48,
    confidence: 0.65,
    calibration: "approximate",
    farM: 20_000,
    alt: "A San Francisco hill falling toward the bay in evening light.",
  },

  {
    id: "img-5077",
    cityId: "taipei-north-coast",
    country: "taiwan",
    location: { latitude: 25.055514, longitude: 121.512231, altitudeM: 14.85 },
    ...exifMeanSeaLevel(19.565, 14.25),
    headingDeg: 197.81,
    pitchDeg: 2.4,
    rollDeg: -0.47,
    focalLengthMm: 15.7,
    focalLength35Mm: 120,
    confidence: 0.62,
    calibration: "approximate",
    farM: 80,
  },
  {
    id: "img-5201",
    cityId: "taipei-north-coast",
    country: "taiwan",
    location: { latitude: 25.108106, longitude: 121.843222, altitudeM: 296.15 },
    ...exifMeanSeaLevel(19.725, 16.17),
    headingDeg: 234.64,
    pitchDeg: -2.92,
    rollDeg: -0.42,
    focalLengthMm: 6.8,
    focalLength35Mm: 48,
    confidence: 0.64,
    calibration: "approximate",
    farM: 2_000,
  },
  {
    id: "img-5441",
    cityId: "taipei-north-coast",
    country: "taiwan",
    location: { latitude: 25.210681, longitude: 121.694983, altitudeM: 8.78 },
    ...exifMeanSeaLevel(19.407, 4.75),
    headingDeg: 1.83,
    pitchDeg: -12.04,
    rollDeg: -0.78,
    focalLengthMm: 15.7,
    focalLength35Mm: 120,
    confidence: 0.61,
    calibration: "approximate",
    farM: 700,
  },
  {
    id: "img-5495",
    cityId: "taipei-north-coast",
    country: "taiwan",
    location: { latitude: 25.033519, longitude: 121.568175, altitudeM: 10.82 },
    ...exifMeanSeaLevel(19.664, 14.25),
    headingDeg: 156.59,
    pitchDeg: 7.71,
    rollDeg: -0.51,
    focalLengthMm: 15.7,
    focalLength35Mm: 120,
    confidence: 0.76,
    calibration: "approximate",
    presentation: "hero",
    preferredTier: "photorealistic",
    highlightApproved: false,
    farM: 850,
  },
  {
    id: "img-5590",
    cityId: "taipei-north-coast",
    country: "taiwan",
    location: { latitude: 25.026736, longitude: 121.575853, altitudeM: 192.62 },
    ...exifMeanSeaLevel(19.687, 4.75),
    headingDeg: 296.58,
    pitchDeg: 2.78,
    rollDeg: -0.13,
    focalLengthMm: 15.7,
    focalLength35Mm: 120,
    confidence: 0.63,
    calibration: "approximate",
    farM: 6_000,
  },
  {
    id: "img-5607",
    cityId: "taipei-north-coast",
    country: "taiwan",
    location: { latitude: 25.026708, longitude: 121.575828, altitudeM: 182.24 },
    ...exifMeanSeaLevel(19.687, 4.75),
    headingDeg: 304,
    pitchDeg: 10,
    rollDeg: 0.16,
    focalLengthMm: 15.7,
    focalLength35Mm: 120,
    source: "manual",
    confidence: 0.8,
    calibration: "approximate",
    farM: 2_500,
  },
  {
    id: "img-5718",
    cityId: "taipei-north-coast",
    country: "taiwan",
    location: { latitude: 25.050858, longitude: 121.525086, altitudeM: 7.83 },
    ...exifMeanSeaLevel(19.588, 21.95),
    headingDeg: 99.35,
    pitchDeg: 4.28,
    rollDeg: 0.19,
    focalLengthMm: 15.7,
    focalLength35Mm: 120,
    confidence: 0.65,
    calibration: "approximate",
    farM: 400,
  },
  {
    id: "img-5772",
    cityId: "taipei-north-coast",
    country: "taiwan",
    location: { latitude: 25.162228, longitude: 121.574469, altitudeM: 759.26 },
    ...exifMeanSeaLevel(19.311, 4.91),
    headingDeg: 170.26,
    pitchDeg: 16.66,
    rollDeg: 1.59,
    focalLengthMm: 6.8,
    focalLength35Mm: 48,
    confidence: 0.61,
    calibration: "approximate",
    preferredTier: "terrain",
    farM: 1_200,
  },
  {
    id: "img-5829",
    cityId: "taipei-north-coast",
    country: "taiwan",
    location: { latitude: 25.166992, longitude: 121.575486, altitudeM: 744.28 },
    ...exifMeanSeaLevel(19.3, 10.77),
    headingDeg: 108.48,
    pitchDeg: 9.21,
    rollDeg: 1.53,
    focalLengthMm: 15.7,
    focalLength35Mm: 120,
    confidence: 0.61,
    calibration: "approximate",
    preferredTier: "terrain",
    farM: 1_000,
  },

  {
    id: "img-2309",
    cityId: "toronto",
    country: "canada",
    location: { latitude: 43.635517, longitude: -79.394364, altitudeM: 81.1 },
    ...exifMeanSeaLevel(-37.267, 4.75),
    headingDeg: 26.18,
    pitchDeg: 1.29,
    rollDeg: -2.16,
    focalLengthMm: 6.8,
    focalLength35Mm: 24,
    source: "exif",
    confidence: 0.7,
    calibration: "approximate",
    preferredTier: "photorealistic",
    farM: 3_500,
    alt: "The illuminated CN Tower above Toronto's snowy waterfront at night.",
  },
  {
    id: "img-2604",
    cityId: "toronto",
    country: "canada",
    location: { latitude: 43.647094, longitude: -79.376908, altitudeM: 102.02 },
    ...exifMeanSeaLevel(-37.272, 27.33),
    headingDeg: 344.77,
    pitchDeg: 7.88,
    rollDeg: 2.04,
    focalLengthMm: 15.7,
    focalLength35Mm: 120,
    source: "exif",
    confidence: 0.68,
    calibration: "approximate",
    preferredTier: "photorealistic",
    farM: 220,
    alt: "Historic red-brick Toronto facades set against rippled glass towers.",
  },
  {
    id: "img-2689",
    cityId: "toronto",
    country: "canada",
    location: { latitude: 43.649403, longitude: -79.420167, altitudeM: 96.74 },
    ...exifMeanSeaLevel(-37.27, 4.48),
    headingDeg: 261.71,
    pitchDeg: 4.71,
    rollDeg: 0.54,
    focalLengthMm: 15.7,
    focalLength35Mm: 120,
    source: "exif",
    confidence: 0.68,
    calibration: "approximate",
    preferredTier: "photorealistic",
    farM: 650,
    alt: "A Toronto streetcar crossing sunlit rails beneath dense overhead wires.",
  },
  {
    id: "img-2713",
    cityId: "toronto",
    country: "canada",
    location: { latitude: 43.645503, longitude: -79.388528, altitudeM: 90.25 },
    ...exifMeanSeaLevel(-37.271, 46.45),
    headingDeg: 217.56,
    pitchDeg: 14.89,
    rollDeg: 3.85,
    focalLengthMm: 6.8,
    focalLength35Mm: 45,
    source: "exif",
    confidence: 0.68,
    calibration: "approximate",
    preferredTier: "photorealistic",
    farM: 320,
    alt: "Steam rising between Toronto towers above a wall of street-level billboards.",
  },
  {
    id: "img-7283",
    cityId: "toronto",
    country: "canada",
    location: { latitude: 43.649053, longitude: -79.393631, altitudeM: 90.28 },
    ...exifMeanSeaLevel(-37.272, 4.75),
    headingDeg: 20.26,
    pitchDeg: 0.92,
    rollDeg: 0.92,
    focalLengthMm: 6.8,
    focalLength35Mm: 48,
    source: "exif",
    confidence: 0.7,
    calibration: "approximate",
    preferredTier: "photorealistic",
    farM: 220,
    alt: "Pedestrians crossing a Toronto intersection between brick storefronts and apartments.",
  },
  {
    id: "img-7449",
    cityId: "toronto",
    country: "canada",
    location: { latitude: 43.671131, longitude: -79.387764, altitudeM: 117.1 },
    ...exifMeanSeaLevel(-37.281, 58),
    headingDeg: 263.92,
    pitchDeg: -0.98,
    rollDeg: 0.12,
    focalLengthMm: 6.8,
    focalLength35Mm: 24,
    source: "exif",
    confidence: 0.45,
    calibration: "needs-manual",
    preferredTier: "photorealistic",
    farM: 15_000,
    alt: "Toronto stretching west at dusk from a high-rise window.",
  },

  {
    id: "img-6850",
    cityId: "bangkok",
    country: "thailand",
    location: { latitude: 13.751978, longitude: 100.502, altitudeM: 11.12 },
    ...exifMeanSeaLevel(-31.609, 8.03),
    headingDeg: 223.73,
    focalLengthMm: 6.8,
    focalLength35Mm: 48,
    confidence: 0.81,
    calibration: "calibrated",
    presentation: "hero",
    preferredTier: "photorealistic",
    highlightApproved: true,
    farM: 500,
  },
  {
    id: "img-6956",
    cityId: "bangkok",
    country: "thailand",
    location: { latitude: 13.740778, longitude: 100.508986, altitudeM: 13.4 },
    ...exifMeanSeaLevel(-31.576, 59.42),
    headingDeg: 295.82,
    focalLengthMm: 6.8,
    focalLength35Mm: 48,
    confidence: 0.66,
    calibration: "approximate",
    farM: 650,
  },
  {
    id: "img-6957",
    cityId: "bangkok",
    country: "thailand",
    location: { latitude: 13.740878, longitude: 100.508811, altitudeM: 7.94 },
    ...exifMeanSeaLevel(-31.577, 23.59),
    headingDeg: 110.31,
    focalLengthMm: 15.7,
    focalLength35Mm: 120,
    confidence: 0.64,
    calibration: "approximate",
    farM: 500,
  },
  {
    id: "img-6998",
    cityId: "bangkok",
    country: "thailand",
    location: { latitude: 13.744019, longitude: 100.488997, altitudeM: 9.36 },
    ...exifMeanSeaLevel(-31.636, 45.72),
    headingDeg: 205.82,
    focalLengthMm: 6.8,
    focalLength35Mm: 24,
    confidence: 0.64,
    calibration: "approximate",
    farM: 550,
  },
  {
    id: "img-7129",
    cityId: "bangkok",
    country: "thailand",
    location: { latitude: 13.7894, longitude: 100.471169, altitudeM: 6.89 },
    ...exifMeanSeaLevel(-31.721, 17.26),
    headingDeg: 222.64,
    focalLengthMm: 6.8,
    focalLength35Mm: 24,
    confidence: 0.63,
    calibration: "approximate",
    farM: 600,
  },
  {
    id: "img-7150",
    cityId: "bangkok",
    country: "thailand",
    location: { latitude: 13.759367, longitude: 100.495933, altitudeM: 9.56 },
    ...exifMeanSeaLevel(-31.632, 18.56),
    headingDeg: 111.02,
    focalLengthMm: 15.7,
    focalLength35Mm: 120,
    confidence: 0.64,
    calibration: "approximate",
    farM: 400,
  },

  {
    id: "img-2784",
    cityId: "hong-kong",
    country: "hong-kong",
    location: { latitude: 22.283075, longitude: 114.155517, altitudeM: 31.49 },
    ...exifMeanSeaLevel(-2.193, 20.85),
    headingDeg: 229.13,
    pitchDeg: 13.27,
    rollDeg: 0.49,
    focalLengthMm: 6.8,
    focalLength35Mm: 42,
    source: "exif",
    confidence: 0.66,
    calibration: "approximate",
    preferredTier: "photorealistic",
    farM: 120,
    alt: "A broad stone staircase climbing between trees and layered Hong Kong buildings.",
  },
  {
    id: "img-2788",
    cityId: "hong-kong",
    country: "hong-kong",
    location: { latitude: 22.283089, longitude: 114.154397, altitudeM: 36.05 },
    ...exifMeanSeaLevel(-2.197, 21.62),
    headingDeg: 171.3,
    pitchDeg: 13.55,
    rollDeg: 1.24,
    focalLengthMm: 6.8,
    focalLength35Mm: 39,
    source: "exif",
    confidence: 0.66,
    calibration: "approximate",
    preferredTier: "photorealistic",
    farM: 120,
    alt: "Restaurants and neon signs stacked above a steep Hong Kong street at night.",
  },
  {
    id: "img-2820",
    cityId: "hong-kong",
    country: "hong-kong",
    location: { latitude: 22.331225, longitude: 114.166642, altitudeM: 41.39 },
    ...exifMeanSeaLevel(-2.226, 3.71),
    headingDeg: 223.68,
    pitchDeg: 2,
    rollDeg: 0.78,
    focalLengthMm: 15.7,
    focalLength35Mm: 120,
    source: "exif",
    confidence: 0.78,
    calibration: "approximate",
    preferredTier: "photorealistic",
    farM: 1_500,
    alt: "A long Hong Kong street compressed between older apartments and dense residential towers.",
  },
  {
    id: "img-2941",
    cityId: "hong-kong",
    country: "hong-kong",
    location: { latitude: 22.284614, longitude: 114.153656, altitudeM: 28.08 },
    ...exifMeanSeaLevel(-2.202, 28.3),
    headingDeg: 237.81,
    pitchDeg: 17.5,
    rollDeg: -0.14,
    focalLengthMm: 6.8,
    focalLength35Mm: 48,
    source: "exif",
    confidence: 0.62,
    calibration: "approximate",
    preferredTier: "photorealistic",
    farM: 250,
    alt: "Stone market steps rising between metal awnings and dense Hong Kong buildings.",
  },
  {
    id: "img-2968",
    cityId: "hong-kong",
    country: "hong-kong",
    location: { latitude: 22.285128, longitude: 114.149414, altitudeM: 32.43 },
    ...exifMeanSeaLevel(-2.218, 21.9),
    headingDeg: 129.6,
    pitchDeg: 15.28,
    rollDeg: -0.04,
    focalLengthMm: 6.8,
    focalLength35Mm: 48,
    source: "exif",
    confidence: 0.65,
    calibration: "approximate",
    preferredTier: "photorealistic",
    farM: 500,
    alt: "A market lane framed by older facades and a patterned residential tower in Hong Kong.",
  },

  {
    id: "dscf9425",
    cityId: "chongqing",
    country: "china",
    location: { latitude: 29.5613, longitude: 106.579, altitudeM: 245 },
    headingDeg: 105,
    pitchDeg: 0,
    focalLengthMm: 20.2,
    focalLength35Mm: 30,
    source: "estimated",
    confidence: 0.25,
    calibration: "needs-manual",
    preferredTier: "terrain",
    farM: 100,
    alt: "A brightly illuminated Chongqing hotpot hall at night.",
  },
  {
    id: "dscf9562",
    cityId: "chongqing",
    country: "china",
    location: { latitude: 29.5545, longitude: 106.535, altitudeM: 315 },
    headingDeg: 70,
    pitchDeg: -4,
    focalLengthMm: 50,
    focalLength35Mm: 75,
    source: "estimated",
    confidence: 0.25,
    calibration: "needs-manual",
    preferredTier: "terrain",
    farM: 850,
    alt: "Traditional hillside buildings surrounded by dense greenery in Chongqing.",
  },
];

export const automaticRejections: AutomaticRejection[] = z
  .array(automaticRejectionSchema)
  .parse(automaticRejectionJson);
export const automaticCameraCandidates = new Map(
  automaticRejections.flatMap((rejection) =>
    rejection.cameraCandidate
      ? ([[rejection.id, rejection.cameraCandidate]] as const)
      : [],
  ),
);
const automaticRejectionIds = new Set(
  automaticRejections.map((rejection) => rejection.id),
);
const automaticPilotSeeds = (automaticPilotJson as PilotSeed[]).filter(
  (seed) => !automaticRejectionIds.has(seed.id),
);
const automaticPilotIds = new Set([
  ...automaticPilotSeeds.map((seed) => seed.id),
]);

export const pilotSeeds: PilotSeed[] = [
  ...authoredPilotSeeds.filter(
    (seed) =>
      !automaticPilotIds.has(seed.id) && !automaticRejectionIds.has(seed.id),
  ),
  ...automaticPilotSeeds,
];
