export type RenderingTier =
  "photorealistic" | "osm-buildings" | "terrain" | "marker" | "gallery";

export type MapMode = "2d" | "3d";

export type ReconstructionMethod = "metadata-assisted" | "image-only";

export type ReconstructionStatus =
  "accepted" | "rejected" | "not-run" | "no-solution";

export type PublicMapAvailability = "google-2d-3d" | "none";

export type CalibrationStatus =
  "unreviewed" | "needs-manual" | "approximate" | "calibrated" | "rejected";

export type PhotoReviewCategory = "complete" | "failed-tests" | "missing-data";

export type GeoPosition = {
  latitude: number;
  longitude: number;
  altitudeM: number;
};

export type PoseSource = "exif" | "estimated" | "manual" | "computer-vision";

export type CameraCandidate = {
  position: GeoPosition;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  horizontalFovDeg: number;
  verticalFovDeg: number;
  nearM: number;
  farM: number;
  confidence: number;
  source: PoseSource;
};

export type MapPlacement =
  | {
      kind: "exact" | "rounded-gps" | "region";
      position: GeoPosition;
    }
  | { kind: "hidden" };

export type PhotoCapabilities = {
  marker: boolean;
  frustum: boolean;
  comparison: boolean;
  projection: boolean;
};

export type PhotoSceneRecord = {
  id: string;
  cityId: string;
  country: string;
  region: string;
  image: {
    manifestId: string;
    url: string;
    thumbnailUrl: string;
    alt: string;
    width: number;
    height: number;
  };
  placement: MapPlacement;
  location: {
    original?: GeoPosition;
    corrected?: GeoPosition;
    altitudeReference: "ellipsoid" | "terrain";
    originalAltitudeReference?:
      "ellipsoid" | "mean-sea-level" | "terrain" | "unknown";
    geoidModel?: "egm96";
    geoidUndulationM?: number;
    horizontalAccuracyM?: number;
  };
  pose: {
    headingDeg?: number;
    pitchDeg?: number;
    rollDeg?: number;
    source: PoseSource;
    confidence: number;
    calibration: CalibrationStatus;
  };
  optics: {
    focalLengthMm?: number;
    focalLength35Mm?: number;
    horizontalFovDeg: number;
    verticalFovDeg: number;
  };
  frustum: { nearM: number; farM: number };
  presentation: "hero" | "standard" | "unsupported";
  preferredTier: RenderingTier;
  privacy: {
    location: "exact" | "rounded" | "city" | "hidden";
    timestamp: "exact" | "date" | "hidden";
  };
  highlight: {
    mode: "projective-texture" | "tint" | "off";
    approved: boolean;
  };
  capabilities: PhotoCapabilities;
  rejectionReasons: string[];
};

export type PublicMapPhotoSummary = Pick<
  PhotoSceneRecord,
  "id" | "placement" | "capabilities" | "rejectionReasons"
> & {
  image: Pick<
    PhotoSceneRecord["image"],
    "thumbnailUrl" | "alt" | "width" | "height"
  >;
  pose: Pick<PhotoSceneRecord["pose"], "calibration">;
  reconstruction: {
    method: ReconstructionMethod;
    status: ReconstructionStatus;
    experimentId?: string;
    evaluation?: PoseEvaluation;
  };
};

export type PoseEvaluation = {
  referenceAvailable: boolean;
  horizontalErrorM?: number;
  altitudeErrorM?: number;
  headingErrorDeg?: number;
  pitchErrorDeg?: number;
  rollErrorDeg?: number;
  horizontalFovErrorDeg?: number;
};

export type ReconstructionVariant = {
  method: ReconstructionMethod;
  status: ReconstructionStatus;
  experimentId?: string;
  summary: PublicMapPhotoSummary;
  record?: PhotoSceneRecord;
  evaluation?: PoseEvaluation;
};

export type CityScenePayload = {
  cityId: string;
  defaultMethod: ReconstructionMethod;
  availableMethods: ReconstructionMethod[];
  variants: Record<string, ReconstructionVariant[]>;
};

export type PoseExperimentConfig = {
  id: string;
  method: "image-only";
  bounds: { west: number; south: number; east: number; north: number };
  cohortPhotoIds: string[];
  gridSpacingM: number;
  candidateLimit: number;
  fallbackCandidateLimit: number;
  suppressionRadiusM: number;
  panoramaRadiusM: number;
  maximumPanoramaDistanceM: number;
};

export type CitySceneConfig = {
  id: string;
  country: string;
  region: string;
  name: string;
  description: string;
  publicMap: PublicMapAvailability;
  center: GeoPosition;
  bounds: { west: number; south: number; east: number; north: number };
  defaultCamera: { headingDeg: number; pitchDeg: number; rangeM: number };
  coverage: {
    photorealistic: "expected" | "verified" | "unsupported" | "unknown";
    osmBuildings: "expected" | "verified" | "unsupported" | "unknown";
    verifiedAt?: string;
  };
  pilotPhotoIds: string[];
  samplePhotoIds: string[];
  poseExperiments?: PoseExperimentConfig[];
};

export function resolvePosition(photo: PhotoSceneRecord): GeoPosition {
  const position = photo.location.corrected ?? photo.location.original;
  if (!position)
    throw new Error(`Photo ${photo.id} has no public map position.`);
  return position;
}
