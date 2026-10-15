import { z } from "zod";
import photographyConfigJson from "@/config/photography.json";
import evaluationsJson from "@/data/photography-image-only-evaluations.json";
import pilotsJson from "@/data/photography-image-only-pilots.json";
import rejectionsJson from "@/data/photography-image-only-rejections.json";
import { fovFromHorizontal } from "./math";
import { geoPositionSchema, poseEvaluationSchema } from "./schema";
import type {
  PhotoSceneRecord,
  PoseEvaluation,
  PoseExperimentConfig,
  PublicMapPhotoSummary,
  ReconstructionVariant,
} from "./types";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const rotationSchema = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
]);
const sealedSchema = z.object({
  algorithm: z.literal("sha256"),
  predictionDigest: digestSchema,
});
const commonSchema = z.object({
  id: z.string().min(1),
  cityId: z.literal("san-francisco"),
  experimentId: z.literal("sf-north-v1"),
  method: z.literal("image-only"),
  pixelDigest: digestSchema,
  pipelineVersion: z.string().min(1),
  pixelRotationDeg: rotationSchema,
  sealed: sealedSchema,
});
const evidenceSchema = z
  .object({
    coarseCandidates: z.number().int().nonnegative(),
    panoramaCandidates: z.number().int().nonnegative(),
    rankedReferences: z.number().int().nonnegative(),
    matches: z.number().int().nonnegative().optional(),
    inliers: z.number().int().nonnegative().optional(),
    inlierRatio: z.number().min(0).max(1).optional(),
    rmsErrorPx: z.number().nonnegative().nullable().optional(),
    imageCoverage: z.number().min(0).max(1).optional(),
    referenceDistanceM: z.number().nonnegative().nullable().optional(),
    ambiguityMarginM: z.number().nonnegative().optional(),
    solutionMode: z.literal("absolute-pose").optional(),
    timingsMs: z.record(z.string(), z.number().nonnegative()).optional(),
  })
  .strict();

export const imageOnlyPilotSchema = commonSchema.extend({
  status: z.literal("accepted"),
  position: geoPositionSchema,
  headingDeg: z.number().min(0).max(360),
  pitchDeg: z.number().min(-90).max(90),
  rollDeg: z.number().min(-180).max(180),
  horizontalFovDeg: z.number().min(20).max(110),
  confidence: z.number().min(0).max(1),
  nearM: z.number().positive(),
  farM: z.number().positive(),
  evidence: evidenceSchema,
  overlayAudit: z
    .object({
      matcher: z.string().min(1),
      geometricInliers: z.number().int().nonnegative(),
      imageCoverage: z.number().min(0).max(1),
      medianResidual: z.number().nonnegative(),
      p90Residual: z.number().nonnegative(),
    })
    .optional(),
});

export const imageOnlyRejectionSchema = commonSchema.extend({
  status: z.enum(["rejected", "no-solution"]),
  rejectionReasons: z.array(z.string().min(1)).min(1),
  evidence: evidenceSchema,
});

export const imageOnlyEvaluationRecordSchema = z.object({
  id: z.string().min(1),
  experimentId: z.literal("sf-north-v1"),
  predictionDigest: digestSchema,
  evaluation: poseEvaluationSchema,
});

export type ImageOnlyPilot = z.infer<typeof imageOnlyPilotSchema>;
export type ImageOnlyRejection = z.infer<typeof imageOnlyRejectionSchema>;
export type ImageOnlyEvaluationRecord = z.infer<
  typeof imageOnlyEvaluationRecordSchema
>;

export const imageOnlyPilots = z.array(imageOnlyPilotSchema).parse(pilotsJson);
export const imageOnlyRejections = z
  .array(imageOnlyRejectionSchema)
  .parse(rejectionsJson);
export const imageOnlyEvaluations = z
  .array(imageOnlyEvaluationRecordSchema)
  .parse(evaluationsJson);

const cityConfig = photographyConfigJson.cities.find(
  (city) => city.id === "san-francisco",
);
const rawExperiment = cityConfig?.poseExperiments?.find(
  (experiment) => experiment.id === "sf-north-v1",
);
if (!rawExperiment)
  throw new Error("The sf-north-v1 pose experiment is not configured.");

export const sfNorthExperiment = rawExperiment as PoseExperimentConfig;
export const sfNorthCohort = new Set(sfNorthExperiment.cohortPhotoIds);

function unavailableSummary(
  baseline: PhotoSceneRecord,
  status: "rejected" | "not-run" | "no-solution",
  rejectionReasons: string[],
  evaluation?: PoseEvaluation,
): PublicMapPhotoSummary {
  return {
    id: baseline.id,
    image: {
      thumbnailUrl: baseline.image.thumbnailUrl,
      alt: baseline.image.alt,
      width: baseline.image.width,
      height: baseline.image.height,
    },
    placement: { kind: "hidden" },
    pose: { calibration: status === "rejected" ? "rejected" : "unreviewed" },
    capabilities: {
      marker: false,
      frustum: false,
      comparison: false,
      projection: false,
    },
    rejectionReasons,
    reconstruction: {
      method: "image-only",
      status,
      experimentId: sfNorthExperiment.id,
      evaluation,
    },
  };
}

function acceptedRecord(
  baseline: PhotoSceneRecord,
  pilot: ImageOnlyPilot,
): PhotoSceneRecord {
  const fov = fovFromHorizontal(
    pilot.horizontalFovDeg,
    baseline.image.width,
    baseline.image.height,
  );
  return {
    ...baseline,
    placement: { kind: "exact", position: pilot.position },
    location: {
      corrected: pilot.position,
      altitudeReference: "ellipsoid",
    },
    pose: {
      headingDeg: pilot.headingDeg,
      pitchDeg: pilot.pitchDeg,
      rollDeg: pilot.rollDeg,
      source: "computer-vision",
      confidence: pilot.confidence,
      calibration: "calibrated",
    },
    optics: {
      horizontalFovDeg: pilot.horizontalFovDeg,
      verticalFovDeg: fov.verticalFovDeg,
    },
    frustum: { nearM: pilot.nearM, farM: pilot.farM },
    highlight: { mode: "off", approved: false },
    capabilities: {
      marker: true,
      frustum: true,
      comparison: true,
      projection: false,
    },
    rejectionReasons: [],
  };
}

function summaryForAccepted(
  record: PhotoSceneRecord,
  evaluation?: PoseEvaluation,
): PublicMapPhotoSummary {
  return {
    id: record.id,
    image: {
      thumbnailUrl: record.image.thumbnailUrl,
      alt: record.image.alt,
      width: record.image.width,
      height: record.image.height,
    },
    placement: record.placement,
    pose: { calibration: record.pose.calibration },
    capabilities: record.capabilities,
    rejectionReasons: record.rejectionReasons,
    reconstruction: {
      method: "image-only",
      status: "accepted",
      experimentId: sfNorthExperiment.id,
      evaluation,
    },
  };
}

export function buildImageOnlyVariants(
  baselinePhotos: PhotoSceneRecord[],
): ReconstructionVariant[] {
  const pilots = new Map(imageOnlyPilots.map((pilot) => [pilot.id, pilot]));
  const rejections = new Map(
    imageOnlyRejections.map((rejection) => [rejection.id, rejection]),
  );
  const evaluations = new Map(
    imageOnlyEvaluations.map((item) => [item.id, item]),
  );

  return baselinePhotos.map((baseline) => {
    const evaluationRecord = evaluations.get(baseline.id);
    const pilot = pilots.get(baseline.id);
    if (pilot) {
      const evaluation =
        evaluationRecord?.predictionDigest === pilot.sealed.predictionDigest
          ? evaluationRecord.evaluation
          : undefined;
      const record = acceptedRecord(baseline, pilot);
      return {
        method: "image-only",
        status: "accepted",
        experimentId: sfNorthExperiment.id,
        summary: summaryForAccepted(record, evaluation),
        record,
        evaluation,
      };
    }

    const rejection = rejections.get(baseline.id);
    if (rejection) {
      const evaluation =
        evaluationRecord?.predictionDigest === rejection.sealed.predictionDigest
          ? evaluationRecord.evaluation
          : undefined;
      return {
        method: "image-only",
        status: rejection.status,
        experimentId: sfNorthExperiment.id,
        summary: unavailableSummary(
          baseline,
          rejection.status,
          rejection.rejectionReasons,
          evaluation,
        ),
        evaluation,
      };
    }

    const inCohort = sfNorthCohort.has(baseline.id);
    return {
      method: "image-only",
      status: "not-run",
      experimentId: sfNorthExperiment.id,
      summary: unavailableSummary(baseline, "not-run", [
        inCohort
          ? "image-only-experiment-not-run"
          : "outside-image-only-pilot-area",
      ]),
    };
  });
}
