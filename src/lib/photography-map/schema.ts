import { z } from "zod";
import type { PoseEvaluation } from "./types";
export type {
  CalibrationStatus,
  CameraCandidate,
  CitySceneConfig,
  GeoPosition,
  MapPlacement,
  PhotoCapabilities,
  PhotoSceneRecord,
  RenderingTier,
} from "./types";
export { resolvePosition } from "./types";

export const renderingTierSchema = z.enum([
  "photorealistic",
  "osm-buildings",
  "terrain",
  "marker",
  "gallery",
]);
export const calibrationStatusSchema = z.enum([
  "unreviewed",
  "needs-manual",
  "approximate",
  "calibrated",
  "rejected",
]);
export const poseSourceSchema = z.enum([
  "exif",
  "estimated",
  "manual",
  "computer-vision",
]);
export const reconstructionMethodSchema = z.enum([
  "metadata-assisted",
  "image-only",
]);
export const reconstructionStatusSchema = z.enum([
  "accepted",
  "rejected",
  "not-run",
  "no-solution",
]);

export const poseEvaluationSchema: z.ZodType<PoseEvaluation> = z.object({
  referenceAvailable: z.boolean(),
  horizontalErrorM: z.number().nonnegative().optional(),
  altitudeErrorM: z.number().nonnegative().optional(),
  headingErrorDeg: z.number().min(0).max(180).optional(),
  pitchErrorDeg: z.number().nonnegative().max(180).optional(),
  rollErrorDeg: z.number().min(0).max(180).optional(),
  horizontalFovErrorDeg: z.number().nonnegative().max(178).optional(),
});

export const geoPositionSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitudeM: z.number().min(-500).max(20_000),
});

export const cameraCandidateSchema = z
  .object({
    position: geoPositionSchema,
    headingDeg: z.number().min(0).max(360),
    pitchDeg: z.number().min(-90).max(90),
    rollDeg: z.number().min(-180).max(180),
    horizontalFovDeg: z.number().min(1).max(179),
    verticalFovDeg: z.number().min(1).max(179),
    nearM: z.number().positive(),
    farM: z.number().positive(),
    confidence: z.number().min(0).max(1),
    source: poseSourceSchema,
  })
  .refine((value) => value.farM > value.nearM, {
    message: "A camera candidate's far distance must exceed its near distance.",
  });

export const photoSceneRecordSchema = z
  .object({
    id: z.string().min(1),
    cityId: z.string().min(1),
    country: z.string().min(1),
    region: z.string().min(1),
    image: z.object({
      manifestId: z.string().min(1),
      url: z.string().min(1),
      thumbnailUrl: z.string().min(1),
      alt: z.string().min(1),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    placement: z.discriminatedUnion("kind", [
      z.object({
        kind: z.enum(["exact", "rounded-gps", "region"]),
        position: geoPositionSchema,
      }),
      z.object({ kind: z.literal("hidden") }),
    ]),
    location: z
      .object({
        original: geoPositionSchema.optional(),
        corrected: geoPositionSchema.optional(),
        altitudeReference: z.enum(["ellipsoid", "terrain"]),
        originalAltitudeReference: z
          .enum(["ellipsoid", "mean-sea-level", "terrain", "unknown"])
          .optional(),
        geoidModel: z.literal("egm96").optional(),
        geoidUndulationM: z.number().min(-150).max(150).optional(),
        horizontalAccuracyM: z.number().positive().optional(),
      })
      .superRefine((value, context) => {
        if (
          value.originalAltitudeReference === "mean-sea-level" &&
          (!value.corrected ||
            value.geoidModel !== "egm96" ||
            value.geoidUndulationM === undefined)
        )
          context.addIssue({
            code: "custom",
            message:
              "Mean-sea-level originals require an EGM96 correction and resolved ellipsoid position.",
          });
      }),
    pose: z.object({
      headingDeg: z.number().min(0).max(360).optional(),
      pitchDeg: z.number().min(-90).max(90).optional(),
      rollDeg: z.number().min(-180).max(180).optional(),
      source: poseSourceSchema,
      confidence: z.number().min(0).max(1),
      calibration: calibrationStatusSchema,
    }),
    optics: z.object({
      focalLengthMm: z.number().positive().optional(),
      focalLength35Mm: z.number().positive().optional(),
      horizontalFovDeg: z.number().min(1).max(179),
      verticalFovDeg: z.number().min(1).max(179),
    }),
    frustum: z
      .object({
        nearM: z.number().positive(),
        farM: z.number().positive(),
      })
      .refine(
        (value) => value.farM > value.nearM,
        "Far distance must exceed near distance.",
      ),
    presentation: z.enum(["hero", "standard", "unsupported"]),
    preferredTier: renderingTierSchema,
    privacy: z.object({
      location: z.enum(["exact", "rounded", "city", "hidden"]),
      timestamp: z.enum(["exact", "date", "hidden"]),
    }),
    highlight: z.object({
      mode: z.enum(["projective-texture", "tint", "off"]),
      approved: z.boolean(),
    }),
    capabilities: z.object({
      marker: z.boolean(),
      frustum: z.boolean(),
      comparison: z.boolean(),
      projection: z.boolean(),
    }),
    rejectionReasons: z.array(z.string()),
  })
  .superRefine((value, context) => {
    const hasPosition = Boolean(
      value.location.original || value.location.corrected,
    );
    if (value.privacy.location === "hidden") {
      if (hasPosition || value.placement.kind !== "hidden")
        context.addIssue({
          code: "custom",
          message: "A hidden photo cannot expose a public map position.",
        });
      if (Object.values(value.capabilities).some(Boolean))
        context.addIssue({
          code: "custom",
          message: "A hidden photo cannot expose map capabilities.",
        });
    } else if (!hasPosition || value.placement.kind === "hidden")
      context.addIssue({
        code: "custom",
        message: "A mapped photo requires a public position.",
      });
  });
