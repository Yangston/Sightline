import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { getCityScenePayload } from "../../src/lib/photography-map/data";
import { sfNorthExperiment } from "../../src/lib/photography-map/image-only";
// Repository scripts are intentionally plain ESM so they also run outside Astro.
import {
  circularDifferenceDeg,
  createCoordinateLattice,
  sealPrediction,
  suppressSpatialNearTies,
  validateImageOnlySolution,
} from "../../scripts/photography/lib/image-only-geometry.mjs";
import { sanitizeImageOnlyPixels } from "../../scripts/photography/lib/image-only-pixels.mjs";
import {
  createStructuredRunLogger,
  redactRunValue,
} from "../../scripts/photography/lib/structured-run-log.mjs";

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sightline-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("sf-north-v1 experiment contract", () => {
  it("freezes the requested bounds, cohort, and search policy", () => {
    expect(sfNorthExperiment.bounds).toEqual({
      west: -122.442,
      south: 37.787,
      east: -122.4115,
      north: 37.808,
    });
    expect(sfNorthExperiment.cohortPhotoIds).toEqual([
      "img-7492",
      "img-7498",
      "img-7526",
      "img-7532",
      "img-7536",
      "img-7561",
      "img-7563",
      "img-7574",
      "img-7577",
      "img-7578",
      "img-7600",
    ]);
    expect(sfNorthExperiment.gridSpacingM).toBe(50);
    expect(sfNorthExperiment.suppressionRadiusM).toBe(150);
  });

  it("returns method variants only for San Francisco", () => {
    expect(getCityScenePayload("san-francisco").availableMethods).toEqual([
      "metadata-assisted",
      "image-only",
    ]);
    expect(getCityScenePayload("toronto").availableMethods).toEqual([
      "metadata-assisted",
    ]);
  });
});

describe("bounded coarse search", () => {
  it("builds an in-bounds 50 metre lattice and suppresses nearby candidates", () => {
    const lattice = createCoordinateLattice(sfNorthExperiment.bounds, 50);
    expect(lattice.length).toBeGreaterThan(1_000);
    expect(
      lattice.every(
        (point: { latitude: number; longitude: number }) =>
          point.latitude >= sfNorthExperiment.bounds.south &&
          point.latitude <= sfNorthExperiment.bounds.north &&
          point.longitude >= sfNorthExperiment.bounds.west &&
          point.longitude <= sfNorthExperiment.bounds.east,
      ),
    ).toBe(true);
    const selected = suppressSpatialNearTies(
      lattice.slice(0, 200).map((point: object, index: number) => ({
        ...point,
        score: 200 - index,
      })),
      { primaryLimit: 12, fallbackLimit: 12, suppressionRadiusM: 150 },
    );
    expect(selected.primary.length).toBeLessThanOrEqual(12);
    expect(selected.fallback.length).toBeLessThanOrEqual(12);
  });

  it("requires absolute PnP, authored bounds, panorama proximity, and no distant near-tie", () => {
    const solved = {
      accepted: true,
      solutionMode: "absolute-pose",
      position: { latitude: 37.799, longitude: -122.42, altitudeM: 50 },
      metrics: { inliers: 24, rmsErrorPx: 2 },
    };
    expect(
      validateImageOnlySolution({
        solved,
        panoramaPosition: solved.position,
        bounds: sfNorthExperiment.bounds,
        maximumPanoramaDistanceM: 250,
      }).accepted,
    ).toBe(true);
    expect(
      validateImageOnlySolution({
        solved,
        panoramaPosition: solved.position,
        bounds: sfNorthExperiment.bounds,
        maximumPanoramaDistanceM: 250,
        competingSolutions: [
          {
            ...solved,
            position: {
              latitude: 37.805,
              longitude: -122.415,
              altitudeM: 50,
            },
          },
        ],
      }).rejectionReasons,
    ).toContain("geographically-distant-near-tie");
  });
});

describe("metadata firewall", () => {
  it("produces identical pixels and sealed predictions when metadata and filenames change", async () => {
    const directory = await temporaryDirectory();
    const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
    const first = path.join(directory, "gps-heading-time-a.jpg");
    const second = path.join(directory, "orientation-focal-b.jpg");
    await sharp(pixels, { raw: { width: 2, height: 2, channels: 3 } })
      .withMetadata({
        orientation: 1,
        exif: { IFD0: { ImageDescription: "gps=1 heading=2 time=3" } },
      })
      .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
      .toFile(first);
    await sharp(pixels, { raw: { width: 2, height: 2, channels: 3 } })
      .withMetadata({
        orientation: 8,
        exif: { IFD0: { ImageDescription: "gps=9 focal=8 time=7" } },
      })
      .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
      .toFile(second);
    const firstSanitized = await sanitizeImageOnlyPixels(
      first,
      path.join(directory, "first.png"),
    );
    const secondSanitized = await sanitizeImageOnlyPixels(
      second,
      path.join(directory, "second.png"),
    );
    expect(firstSanitized).toEqual(secondSanitized);
    const visualPrediction = {
      id: "opaque-photo",
      pixelDigest: firstSanitized.pixelDigest,
      bounds: sfNorthExperiment.bounds,
      status: "no-solution",
    };
    expect(sealPrediction(visualPrediction)).toBe(
      sealPrediction({
        ...visualPrediction,
        pixelDigest: secondSanitized.pixelDigest,
      }),
    );
  });

  it("keeps circular device-error evaluation independent of prediction sealing", () => {
    expect(circularDifferenceDeg(359, 1)).toBe(2);
    const before = sealPrediction({ status: "accepted", headingDeg: 359 });
    circularDifferenceDeg(359, 1);
    expect(sealPrediction({ status: "accepted", headingDeg: 359 })).toBe(
      before,
    );
  });
});

describe("structured observability", () => {
  it("redacts credentials, provider URLs, paths, and EXIF-like fields", () => {
    expect(
      redactRunValue({
        apiKey: "secret",
        exifGps: { latitude: 1 },
        url: "https://maps.example.test/image?key=secret",
        path: "C:\\private\\photo.jpg",
      }),
    ).toEqual({
      apiKey: "[redacted]",
      exifGps: "[redacted]",
      url: "[provider-url-redacted]",
      path: "[private-path-redacted]",
    });
  });

  it("writes ordered JSONL and a self-contained HTML timeline", async () => {
    const directory = await temporaryDirectory();
    const logger = await createStructuredRunLogger({
      root: directory,
      experimentId: "sf-north-v1",
    });
    await logger.event("intake", { photoId: "opaque", status: "started" });
    await logger.event("pixel-sanitization", {
      photoId: "opaque",
      status: "complete",
    });
    const report = await logger.finish({ status: "complete" });
    const lines = (await readFile(logger.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((item) => item.sequence)).toEqual([1, 2]);
    expect(await readFile(report.reportPath, "utf8")).toContain(
      "<!doctype html>",
    );
  });
});
