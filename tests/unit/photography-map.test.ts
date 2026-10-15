import { describe, expect, it } from "vitest";
import {
  cameraDirectionEnu,
  containAwareFov,
  cropAwareFov,
  enuToEcefVector,
  fovFrom35mmEquivalent,
  fovFromSensor,
  frustumCorners,
  geodeticToEcef,
} from "../../src/lib/photography-map/math";
import { photoSceneRecordSchema } from "../../src/lib/photography-map/schema";
import {
  getPilotPhotosForCity,
  pilotPhotos,
} from "../../src/lib/photography-map/data";
import { cityScenes } from "../../src/lib/photography-map/cities";
import {
  buildSatelliteTileGrid,
  deriveStaticMapViewport,
  projectStaticMapPosition,
} from "../../src/lib/photography-map/static-map";
import automaticPilots from "../../src/data/photography-auto-pilots.json";
import automaticRejections from "../../src/data/photography-auto-rejections.json";
import manifest from "../../src/data/photography-manifest.json";
import {
  nextSimplerTier,
  selectRenderingTier,
  type TierCapabilities,
} from "../../src/lib/photography-map/tiers";

describe("camera optics", () => {
  it("derives rectangular FOV from 35 mm diagonal equivalence", () => {
    const landscape = fovFrom35mmEquivalent(50, 6000, 4000);
    const portrait = fovFrom35mmEquivalent(50, 4000, 6000);
    expect(landscape.horizontalFovDeg).toBeCloseTo(portrait.verticalFovDeg, 8);
    expect(landscape.verticalFovDeg).toBeCloseTo(portrait.horizontalFovDeg, 8);
    expect(landscape.horizontalFovDeg).toBeGreaterThan(
      landscape.verticalFovDeg,
    );
  });

  it("uses physical sensor dimensions when available", () => {
    const fov = fovFromSensor(23.5, 23.5, 15.6);
    expect(fov.horizontalFovDeg).toBeCloseTo(53.13, 1);
    expect(fov.verticalFovDeg).toBeCloseTo(36.75, 1);
  });

  it("accounts for cover-cropping into a different viewport", () => {
    const result = cropAwareFov(60, 40, 1.5, 2);
    expect(result.horizontalFovDeg).toBe(60);
    expect(result.verticalFovDeg).toBeLessThan(40);
  });

  it("contains a photo frustum in a differently shaped map viewport", () => {
    const portraitInWideMap = containAwareFov(40, 60, 2 / 3, 16 / 9);
    expect(portraitInWideMap.verticalFovDeg).toBe(60);
    expect(portraitInWideMap.horizontalFovDeg).toBeGreaterThan(40);

    const landscapeInTallMap = containAwareFov(60, 40, 3 / 2, 3 / 4);
    expect(landscapeInTallMap.horizontalFovDeg).toBe(60);
    expect(landscapeInTallMap.verticalFovDeg).toBeGreaterThan(40);
  });
});

describe("coordinate and frustum math", () => {
  it("converts the equator and prime meridian to WGS84 ECEF", () => {
    expect(geodeticToEcef({ latitude: 0, longitude: 0, altitudeM: 0 })).toEqual(
      { x: 6_378_137, y: 0, z: 0 },
    );
  });

  it("uses true-north clockwise heading in the local ENU frame", () => {
    expect(cameraDirectionEnu(0, 0)).toEqual({ x: 0, y: 1, z: 0 });
    const east = cameraDirectionEnu(90, 0);
    expect(east.x).toBeCloseTo(1, 8);
    expect(east.y).toBeCloseTo(0, 8);
    expect(
      enuToEcefVector(
        { x: 1, y: 0, z: 0 },
        { latitude: 0, longitude: 0, altitudeM: 0 },
      ),
    ).toEqual({ x: 0, y: 1, z: 0 });
  });

  it("builds four rectangular corners on both near and far planes", () => {
    const corners = frustumCorners(90, 60, 1, 10);
    expect(corners).toHaveLength(8);
    expect(corners[0].z).toBe(1);
    expect(corners[4].z).toBe(10);
    expect(Math.abs(corners[4].x)).toBeCloseTo(10, 8);
  });
});

describe("public city map eligibility and satellite viewport", () => {
  it("enables only the three coverage-reviewed urban scenes", () => {
    expect(
      cityScenes
        .filter(({ publicMap }) => publicMap === "google-2d-3d")
        .map(({ id }) => id)
        .sort(),
    ).toEqual(["hong-kong", "san-francisco", "toronto"]);
  });

  it("creates a viewport-filling Google satellite tile grid", () => {
    const city = cityScenes.find(({ id }) => id === "san-francisco")!;
    const viewport = deriveStaticMapViewport(city.bounds);
    const tiles = buildSatelliteTileGrid(
      viewport,
      "session-token",
      "public-test-key",
    );
    expect(tiles.length).toBeGreaterThanOrEqual(6);
    const url = new URL(tiles[0].url);
    expect(url.origin).toBe("https://tile.googleapis.com");
    expect(url.pathname).toMatch(/^\/v1\/2dtiles\/\d+\/\d+\/\d+$/);
    expect(url.searchParams.get("session")).toBe("session-token");
    expect(url.searchParams.get("key")).toBe("public-test-key");
    expect(Math.min(...tiles.map(({ left }) => left))).toBeLessThanOrEqual(0);
    expect(Math.min(...tiles.map(({ top }) => top))).toBeLessThanOrEqual(0);
  });

  it("uses the same Web Mercator viewport for the image and markers", () => {
    const city = cityScenes.find(({ id }) => id === "toronto")!;
    const viewport = deriveStaticMapViewport(city.bounds);
    expect(Number.isInteger(viewport.zoom)).toBe(true);
    expect(viewport.width / viewport.height).toBe(16 / 9);
    expect(projectStaticMapPosition(viewport.center, viewport)).toEqual({
      x: 50,
      y: 50,
    });
    for (const photo of getPilotPhotosForCity(city.id)) {
      if (photo.placement.kind === "hidden") continue;
      const point = projectStaticMapPosition(
        photo.placement.position,
        viewport,
      );
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(100);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(100);
    }
  });
});

describe("validation and fallback selection", () => {
  const capabilities: TierCapabilities = {
    webgl: true,
    googleKey: true,
    ionToken: true,
    mobile: false,
    saveData: false,
    photorealisticCoverage: "expected",
    osmCoverage: "expected",
    hasLocation: true,
    hasPose: true,
    calibration: "calibrated",
  };

  it("selects and demotes progressive tiers", () => {
    expect(selectRenderingTier(capabilities)).toBe("photorealistic");
    expect(
      selectRenderingTier({ ...capabilities, calibration: "rejected" }),
    ).toBe("photorealistic");
    expect(
      selectRenderingTier({
        ...capabilities,
        photorealisticCoverage: "unsupported",
      }),
    ).toBe("osm-buildings");
    expect(selectRenderingTier({ ...capabilities, googleKey: false })).toBe(
      "osm-buildings",
    );
    expect(
      selectRenderingTier({
        ...capabilities,
        googleKey: false,
        ionToken: false,
      }),
    ).toBe("terrain");
    expect(selectRenderingTier({ ...capabilities, webgl: false })).toBe(
      "marker",
    );
    expect(selectRenderingTier({ ...capabilities, hasLocation: false })).toBe(
      "gallery",
    );
    expect(selectRenderingTier({ ...capabilities, mobile: true })).toBe(
      "terrain",
    );
    expect(nextSimplerTier("photorealistic")).toBe("osm-buildings");
    expect(nextSimplerTier("gallery")).toBe("gallery");
  });

  it("rejects invalid pose and frustum data", () => {
    const invalid = {
      id: "bad",
      cityId: "test",
      country: "test",
      image: {
        manifestId: "bad",
        url: "/bad.webp",
        alt: "Bad",
        width: 10,
        height: 10,
      },
      location: {
        original: { latitude: 100, longitude: 0, altitudeM: 0 },
        altitudeReference: "ellipsoid",
      },
      pose: {
        headingDeg: 0,
        pitchDeg: 0,
        rollDeg: 0,
        source: "manual",
        confidence: 1,
        calibration: "calibrated",
      },
      optics: { horizontalFovDeg: 60, verticalFovDeg: 60 },
      frustum: { nearM: 10, farM: 1 },
      presentation: "hero",
      preferredTier: "photorealistic",
      privacy: { location: "exact", timestamp: "date" },
      highlight: { mode: "tint", approved: true },
    };
    expect(photoSceneRecordSchema.safeParse(invalid).success).toBe(false);
  });

  it("preserves EXIF sea-level altitude and resolves EGM96 ellipsoid height", () => {
    for (const seed of automaticPilots) {
      const photo = getPilotPhotosForCity(seed.cityId).find(
        (candidate) => candidate.id === seed.id,
      )!;
      expect(photo.location.originalAltitudeReference).toBe("mean-sea-level");
      expect(photo.location.geoidModel).toBe("egm96");
      const geoidPrior =
        photo.location.original!.altitudeM + photo.location.geoidUndulationM!;
      expect(
        Math.abs(photo.location.corrected!.altitudeM - geoidPrior),
      ).toBeLessThanOrEqual(photo.location.horizontalAccuracyM!);
    }
  });

  it("publishes only exact-render-verified automatic records", () => {
    const rejectedIds = new Set(automaticRejections.map(({ id }) => id));
    expect(automaticPilots.length).toBeGreaterThan(0);

    for (const seed of automaticPilots) {
      expect(rejectedIds.has(seed.id)).toBe(false);
      expect(["lightglue-superpoint", "lightglue-aliked"]).toContain(
        seed.automaticEvidence.matcher,
      );
      expect(seed.automaticEvidence.overlayAudit).toBeDefined();

      const matches = getPilotPhotosForCity(seed.cityId).filter(
        (photo) => photo.id === seed.id,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].pose.source).toBe("computer-vision");
      expect(matches[0].pose.calibration).toBe("calibrated");
    }
  });

  it("keeps accepted automatic optics and frustums internally consistent", () => {
    for (const seed of automaticPilots) {
      const projectedAspect =
        Math.tan((seed.horizontalFovDeg * Math.PI) / 360) /
        Math.tan((seed.verticalFovDeg * Math.PI) / 360);
      const photo = getPilotPhotosForCity(seed.cityId).find(
        (candidate) => candidate.id === seed.id,
      )!;
      expect(projectedAspect).toBeCloseTo(
        photo.image.width / photo.image.height,
        3,
      );
      expect(seed.nearM).toBeGreaterThan(0);
      expect(seed.farM).toBeGreaterThan(seed.nearM);

      const depth = seed.automaticEvidence.frustumDepth;
      expect(depth.accepted).toBe(true);
      expect(depth.validDepthCount).toBeGreaterThanOrEqual(12);
      expect(depth.percentilesM!.p98).toBeLessThanOrEqual(50_000);
      expect(seed.nearM).toBeCloseTo(depth.frustum!.nearM, 8);
      expect(seed.farM).toBeCloseTo(depth.frustum!.farM, 8);
    }
  });

  it("retains strict exact-render evidence for every published automatic pose", () => {
    for (const seed of automaticPilots) {
      const audit = seed.automaticEvidence.overlayAudit!;
      expect(audit.geometricInliers).toBeGreaterThanOrEqual(8);
      expect(audit.imageCoverage).toBeGreaterThanOrEqual(0.01);
      expect(audit.medianResidual).toBeLessThanOrEqual(0.04);
      expect(audit.p90Residual).toBeLessThanOrEqual(0.1);
    }
  });

  it("publishes every manifest photo once and exposes approved rejected candidates", () => {
    expect(pilotPhotos).toHaveLength(manifest.length);
    expect(new Set(pilotPhotos.map(({ id }) => id)).size).toBe(manifest.length);
    expect(pilotPhotos.map(({ id }) => id).sort()).toEqual(
      manifest.map(({ id }) => id).sort(),
    );

    const eligible = new Set(["san-francisco", "toronto", "hong-kong"]);
    for (const rejection of automaticRejections) {
      const matches = getPilotPhotosForCity(rejection.cityId).filter(
        (photo) => photo.id === rejection.id,
      );
      expect(matches).toHaveLength(1);
      const photo = matches[0];
      expect(photo.pose.calibration).toBe("rejected");
      expect(photo.rejectionReasons.length).toBeGreaterThan(0);
      expect(photo.capabilities).toEqual(
        eligible.has(rejection.cityId)
          ? {
              marker: true,
              frustum: true,
              comparison: true,
              projection: false,
            }
          : {
              marker: true,
              frustum: false,
              comparison: false,
              projection: false,
            },
      );
      expect(photo.placement.kind).toBe(
        eligible.has(rejection.cityId) ? "exact" : "rounded-gps",
      );
    }
  });

  it("publishes complete sanitized candidates for all eligible failed tests", () => {
    const eligible = new Set(["san-francisco", "toronto", "hong-kong"]);
    const failures = automaticRejections.filter(({ cityId }) =>
      eligible.has(cityId),
    );
    expect(failures).toHaveLength(24);
    expect(failures.every(({ cameraCandidate }) => cameraCandidate)).toBe(true);
    const metadataFallback = failures.find(({ id }) => id === "img-7563")!;
    const candidate = metadataFallback.cameraCandidate;
    expect(candidate).toBeDefined();
    if (!candidate)
      throw new Error("img-7563 is missing its camera candidate.");
    expect(candidate.source).toBe("exif");
    expect(candidate.nearM).toBe(1);
    expect(candidate.farM).toBe(500);
  });

  it("exposes camera geometry only for records approved as exact", () => {
    const poseRecords = pilotPhotos.filter(
      ({ capabilities }) => capabilities.frustum,
    );
    const expectedIds = new Set(
      pilotPhotos
        .filter(({ privacy }) => privacy.location === "exact")
        .map(({ id }) => id),
    );
    expect(new Set(poseRecords.map(({ id }) => id))).toEqual(expectedIds);
    expect(
      poseRecords.every(({ placement }) => placement.kind === "exact"),
    ).toBe(true);
    expect(
      pilotPhotos
        .filter(({ privacy }) => privacy.location !== "exact")
        .every(
          ({ capabilities }) =>
            !capabilities.frustum &&
            !capabilities.comparison &&
            !capabilities.projection,
        ),
    ).toBe(true);
  });

  it("contains no evidence from retired calibration implementations", () => {
    const serialized = JSON.stringify(automaticPilots).toLowerCase();
    for (const retired of [
      "disk",
      "roma",
      "sift",
      "geoclip",
      "clip",
      "multiviewtriangulation",
      "landmarkconstraint",
      "registered-archive",
      "screen-servo",
      "pycolmap",
    ])
      expect(serialized).not.toContain(retired);
  });

  it("rejects an unconverted mean-sea-level location", () => {
    const valid = getPilotPhotosForCity("san-francisco")[0];
    const result = photoSceneRecordSchema.safeParse({
      ...valid,
      location: {
        original: valid.location.original,
        altitudeReference: "ellipsoid",
        originalAltitudeReference: "mean-sea-level",
      },
    });
    expect(result.success).toBe(false);
  });
});
