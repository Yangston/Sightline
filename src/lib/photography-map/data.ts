import manifestJson from "@/data/photography-manifest.json";
import mapRecordsJson from "@/data/photography-map-records.json";
import { fovFrom35mmEquivalent } from "./math";
import {
  authoredPilotSeeds,
  automaticCameraCandidates,
  pilotSeeds,
  type PilotSeed,
} from "./pilot";
import { photoSceneRecordSchema } from "./schema";
import { buildImageOnlyVariants } from "./image-only";
import type {
  CalibrationStatus,
  CityScenePayload,
  MapPlacement,
  PhotoSceneRecord,
  PublicMapPhotoSummary,
  ReconstructionMethod,
  ReconstructionVariant,
} from "./types";

type ManifestItem = {
  id: string;
  country: string;
  region: string;
  width: number;
  height: number;
  alt: string;
  variants: { width: number; src: string }[];
};

type MapRecord = {
  id: string;
  country: string;
  region: string;
  sceneId: string;
  placement: MapPlacement;
  privacy: {
    location: "exact" | "rounded" | "city" | "hidden";
    timestamp: "date" | "hidden";
  };
  calibration: CalibrationStatus;
  rejectionReasons: string[];
  capabilities: {
    marker: boolean;
    frustum: boolean;
    comparison: boolean;
    projection: boolean;
  };
};

const manifest = manifestJson as ManifestItem[];
const mapRecords = mapRecordsJson as MapRecord[];
const seedById = new Map(pilotSeeds.map((seed) => [seed.id, seed]));
const authoredSeedById = new Map(
  authoredPilotSeeds.map((seed) => [seed.id, seed]),
);

function fovFor(seed: PilotSeed | undefined, image: ManifestItem) {
  if (seed?.horizontalFovDeg !== undefined && seed.verticalFovDeg !== undefined)
    return {
      horizontalFovDeg: seed.horizontalFovDeg,
      verticalFovDeg: seed.verticalFovDeg,
    };
  return seed?.focalLength35Mm
    ? fovFrom35mmEquivalent(seed.focalLength35Mm, image.width, image.height)
    : { horizontalFovDeg: 55, verticalFovDeg: 42 };
}

function seedPosition(seed: PilotSeed) {
  const geoidCorrected =
    seed.originalAltitudeReference === "mean-sea-level" &&
    seed.geoidUndulationM !== undefined
      ? {
          ...seed.location,
          altitudeM: seed.location.altitudeM + seed.geoidUndulationM,
        }
      : undefined;
  return { corrected: seed.corrected ?? geoidCorrected };
}

export const pilotPhotos: PhotoSceneRecord[] = mapRecords.map((mapRecord) => {
  const image = manifest.find((item) => item.id === mapRecord.id);
  if (!image)
    throw new Error(
      `Mapped photo ${mapRecord.id} is missing from the photography manifest.`,
    );
  const exposesCamera = mapRecord.privacy.location === "exact";
  const seed = exposesCamera
    ? (seedById.get(mapRecord.id) ?? authoredSeedById.get(mapRecord.id))
    : undefined;
  const cameraCandidate = exposesCamera
    ? automaticCameraCandidates.get(mapRecord.id)
    : undefined;
  const rejected = mapRecord.calibration === "rejected";
  const resolvedSeed = seed ? seedPosition(seed) : undefined;
  const position =
    cameraCandidate?.position ??
    (seed
      ? (resolvedSeed?.corrected ?? seed.location)
      : mapRecord.placement.kind === "hidden"
        ? undefined
        : mapRecord.placement.position);
  const placement = mapRecord.placement;
  const calibration = rejected
    ? "rejected"
    : (seed?.calibration ?? mapRecord.calibration);
  const projection = mapRecord.capabilities.projection;

  return photoSceneRecordSchema.parse({
    id: mapRecord.id,
    cityId: mapRecord.sceneId,
    country: image.country,
    region: image.region,
    image: {
      manifestId: image.id,
      url: image.variants.at(-1)!.src,
      thumbnailUrl: image.variants[0].src,
      alt: seed?.alt ?? image.alt,
      width: image.width,
      height: image.height,
    },
    placement,
    location: {
      original: cameraCandidate ? undefined : (seed?.location ?? position),
      corrected: cameraCandidate?.position ?? resolvedSeed?.corrected,
      altitudeReference: "ellipsoid",
      originalAltitudeReference: cameraCandidate
        ? "unknown"
        : (seed?.originalAltitudeReference ?? "ellipsoid"),
      geoidModel:
        !cameraCandidate && seed?.originalAltitudeReference === "mean-sea-level"
          ? "egm96"
          : undefined,
      geoidUndulationM: cameraCandidate ? undefined : seed?.geoidUndulationM,
      horizontalAccuracyM: cameraCandidate
        ? undefined
        : seed?.horizontalAccuracyM,
    },
    pose: {
      headingDeg: cameraCandidate?.headingDeg ?? seed?.headingDeg,
      pitchDeg: cameraCandidate?.pitchDeg ?? seed?.pitchDeg,
      rollDeg: cameraCandidate?.rollDeg ?? seed?.rollDeg,
      source:
        cameraCandidate?.source ??
        seed?.source ??
        (placement.kind === "region" || placement.kind === "hidden"
          ? "estimated"
          : "exif"),
      confidence:
        cameraCandidate?.confidence ??
        seed?.confidence ??
        (placement.kind === "region" || placement.kind === "hidden"
          ? 0.1
          : 0.35),
      calibration,
    },
    optics: {
      focalLengthMm: seed?.focalLengthMm,
      focalLength35Mm: seed?.focalLength35Mm,
      ...(cameraCandidate
        ? {
            horizontalFovDeg: cameraCandidate.horizontalFovDeg,
            verticalFovDeg: cameraCandidate.verticalFovDeg,
          }
        : fovFor(seed, image)),
    },
    frustum: {
      nearM: cameraCandidate?.nearM ?? seed?.nearM ?? 1,
      farM: cameraCandidate?.farM ?? seed?.farM ?? 500,
    },
    presentation: seed?.presentation ?? "standard",
    preferredTier:
      seed?.preferredTier ??
      (placement.kind === "region"
        ? "marker"
        : placement.kind === "hidden"
          ? "gallery"
          : "terrain"),
    privacy: mapRecord.privacy,
    highlight: {
      mode: projection ? (seed?.highlightMode ?? "projective-texture") : "off",
      approved: projection,
    },
    capabilities: mapRecord.capabilities,
    rejectionReasons: mapRecord.rejectionReasons,
  });
});

export function getPilotPhotosForCountry(country: string) {
  return pilotPhotos.filter((photo) => photo.country === country);
}

export function getPilotPhotosForCity(cityId: string) {
  return pilotPhotos.filter((photo) => photo.cityId === cityId);
}

export function getPublicMapPhotoSummariesForCity(cityId: string) {
  return getPilotPhotosForCity(cityId).map<PublicMapPhotoSummary>((photo) => ({
    id: photo.id,
    image: {
      thumbnailUrl: photo.image.thumbnailUrl,
      alt: photo.image.alt,
      width: photo.image.width,
      height: photo.image.height,
    },
    placement: photo.placement,
    pose: { calibration: photo.pose.calibration },
    capabilities: photo.capabilities,
    rejectionReasons: photo.rejectionReasons,
    reconstruction: {
      method: "metadata-assisted",
      status: photo.pose.calibration === "rejected" ? "rejected" : "accepted",
    },
  }));
}

function baselineVariants(cityId: string): ReconstructionVariant[] {
  const summaries = new Map(
    getPublicMapPhotoSummariesForCity(cityId).map((summary) => [
      summary.id,
      summary,
    ]),
  );
  return getPilotPhotosForCity(cityId).map((record) => ({
    method: "metadata-assisted" as const,
    status:
      record.pose.calibration === "rejected"
        ? ("rejected" as const)
        : ("accepted" as const),
    summary: summaries.get(record.id)!,
    record,
  }));
}

export function getReconstructionVariantsForCity(
  cityId: string,
  method: ReconstructionMethod,
) {
  const baseline = getPilotPhotosForCity(cityId);
  if (method === "image-only" && cityId === "san-francisco")
    return buildImageOnlyVariants(baseline);
  return baselineVariants(cityId);
}

export function getCityScenePayload(cityId: string): CityScenePayload {
  const metadataAssisted = baselineVariants(cityId);
  const availableMethods: ReconstructionMethod[] = ["metadata-assisted"];
  const variants: Record<string, ReconstructionVariant[]> = {
    "metadata-assisted": metadataAssisted,
  };
  if (cityId === "san-francisco") {
    availableMethods.push("image-only");
    variants["image-only"] = buildImageOnlyVariants(
      getPilotPhotosForCity(cityId),
    );
  }
  return {
    cityId,
    defaultMethod: "metadata-assisted",
    availableMethods,
    variants,
  };
}

export function getPublicMapPhotoSummariesForMethod(
  cityId: string,
  method: ReconstructionMethod,
) {
  return getReconstructionVariantsForCity(cityId, method).map(
    (variant) => variant.summary,
  );
}
