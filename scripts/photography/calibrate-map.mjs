import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import { geoidUndulationM, readGeoidPgm } from "./lib/geoid-grid.mjs";
import {
  providerDepthMissesSolvedSurfaces,
  providerDepthOverridesSolvedRange,
  providerDepthTruncatesTrustedRange,
} from "./lib/frustum-depth.mjs";
import {
  createProgressReporter,
  withActivity,
} from "./lib/terminal-progress.mjs";
import {
  cameraCandidateFromSeed,
  cameraCandidateFromSolved,
} from "./lib/camera-candidate.mjs";
import {
  assertPhotographyCalibrationPrerequisites,
  cityForGps,
} from "./lib/reconstruction-prerequisites.mjs";
import { photographyCities as cities } from "./lib/photography-config.mjs";
import { validateImageOnlySolution } from "./lib/image-only-geometry.mjs";

const root = process.cwd();
const manifestPath = path.join(root, "src/data/photography-manifest.json");
const automaticPilotsPath = path.join(
  root,
  "src/data/photography-auto-pilots.json",
);
const automaticRejectionsPath = path.join(
  root,
  "src/data/photography-auto-rejections.json",
);
const metadataPath = path.join(root, ".private/photography-metadata.json");
let workRoot = path.join(root, ".private/photo-auto-calibration");
const geoidPath = path.join(
  root,
  ".private/geoid/egm96-15/geoids/egm96-15.pgm",
);
const venvPython = path.join(
  root,
  ".venv-photo-calibration",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const modelReadyPath = path.join(
  root,
  ".venv-photo-calibration",
  ".models-ready",
);
const cliArgs = process.argv.slice(2);
const flags = new Set(cliArgs);
const setup = flags.has("--setup");
const calibrateIdsArg = cliArgs.find((value) =>
  value.startsWith("--calibrate-ids="),
);
const calibrateIds =
  calibrateIdsArg?.split("=")[1].split(",").filter(Boolean) ?? [];
const replaceCalibration = flags.has("--replace-calibration");
const imageOnlyRequestArg = cliArgs.find((value) =>
  value.startsWith("--image-only-request="),
);
const imageOnlyRequestPath = imageOnlyRequestArg?.slice(
  imageOnlyRequestArg.indexOf("=") + 1,
);
const spawnServer = flags.has("--spawn-server");
const serverArg = cliArgs.find((value) => value.startsWith("--server-url="));
const supportedArgs = new Set([
  "--setup",
  "--replace-calibration",
  "--spawn-server",
  calibrateIdsArg,
  imageOnlyRequestArg,
  serverArg,
]);
const unsupportedArgs = cliArgs.filter((value) => !supportedArgs.has(value));
if (unsupportedArgs.length)
  throw new Error(
    `Unsupported internal map option: ${unsupportedArgs.join(", ")}`,
  );
const serverUrl = serverArg?.split("=")[1] ?? "http://127.0.0.1:4322";
const envText = await readFile(path.join(root, ".env"), "utf8").catch(() => "");
const googleKey =
  process.env.PUBLIC_GOOGLE_MAP_TILES_API_KEY?.trim() ??
  envText.match(/^PUBLIC_GOOGLE_MAP_TILES_API_KEY=(.+)$/m)?.[1].trim();
const elevationCache = new Map();

function isPublishingMatcher(name) {
  return ["lightglue-superpoint", "lightglue-aliked"].includes(name);
}

function numberFrom(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const result = Number.parseFloat(value);
    if (Number.isFinite(result)) return result;
  }
  return undefined;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(
            new Error(
              `${command} ${args.join(" ")} failed (${code}).${
                options.privateOutput
                  ? " Captured subprocess output withheld."
                  : `\n${stderr || stdout}`
              }`,
            ),
          ),
    );
  });
}

async function setupEnvironment() {
  console.log("[setup 1/5] Checking the isolated calibration environment...");
  try {
    await access(venvPython);
  } catch {
    console.log("[setup 2/5] Creating the calibration virtual environment...");
    await run("python", [
      "-m",
      "venv",
      path.join(root, ".venv-photo-calibration"),
    ]);
  }
  console.log(
    "[setup 3/5] Installing pinned LightGlue, GeoCLIP 1.2.0, and CLIP dependencies...",
  );
  await run(venvPython, [
    "-m",
    "pip",
    "install",
    "-r",
    path.join(root, "scripts/photography/calibration/requirements.txt"),
  ]);
  console.log("[setup 4/5] Preloading feature, GeoCLIP, and CLIP weights...");
  await run(venvPython, [
    path.join(root, "scripts/photography/calibration/preload_features.py"),
  ]);
  console.log("[setup 5/5] Verifying every model from the offline cache...");
  await run(
    venvPython,
    [
      path.join(root, "scripts/photography/calibration/preload_features.py"),
      "--check",
    ],
    {
      env: {
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
      },
    },
  );
  await writeFile(modelReadyPath, `${new Date().toISOString()}\n`);
}

async function assertCalibrationPrerequisites({
  persistModelMarker = true,
} = {}) {
  const prerequisites = {
    root,
    venvPython,
    modelReadyPath,
    geoidPath,
    astroPath: path.join(root, "node_modules/astro/bin/astro.mjs"),
    googleKey,
  };
  try {
    await assertPhotographyCalibrationPrerequisites(prerequisites);
    return;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("Calibration models have not been verified")
    ) {
      throw error;
    }
  }

  console.log("Verifying the existing calibration models from local caches...");
  await run(
    venvPython,
    [
      path.join(root, "scripts/photography/calibration/preload_features.py"),
      "--check",
    ],
    {
      capture: true,
      privateOutput: true,
      env: {
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
      },
    },
  );
  await assertPhotographyCalibrationPrerequisites({
    ...prerequisites,
    modelReadyPath: venvPython,
  });
  if (persistModelMarker) {
    await writeFile(modelReadyPath, `${new Date().toISOString()}\n`);
  }
  console.log(
    persistModelMarker
      ? "Existing calibration models verified."
      : "Existing calibration models verified without changing setup state.",
  );
}

function fovFrom35mm(focal, width, height) {
  const diagonal = Math.hypot(36, 24);
  const imageDiagonal = Math.hypot(width, height);
  const sensorWidth = (diagonal * width) / imageDiagonal;
  const sensorHeight = (diagonal * height) / imageDiagonal;
  return {
    horizontalFovDeg:
      (2 * Math.atan(sensorWidth / (2 * focal)) * 180) / Math.PI,
    verticalFovDeg: (2 * Math.atan(sensorHeight / (2 * focal)) * 180) / Math.PI,
  };
}

function worldDistanceM(origin, point) {
  const earthRadiusM = 6_378_137;
  const latitudeScale = (Math.PI / 180) * earthRadiusM;
  const longitudeScale =
    latitudeScale * Math.cos((origin.latitude * Math.PI) / 180);
  return Math.hypot(
    (point.latitude - origin.latitude) * latitudeScale,
    (point.longitude - origin.longitude) * longitudeScale,
    point.altitudeM - origin.altitudeM,
  );
}

function offsetCameraPosition(position, pose, forwardM, upM) {
  const heading = (pose.headingDeg * Math.PI) / 180;
  const pitch = (pose.pitchDeg * Math.PI) / 180;
  const horizontalM = forwardM * Math.cos(pitch);
  const northM = horizontalM * Math.cos(heading);
  const eastM = horizontalM * Math.sin(heading);
  return {
    latitude: position.latitude + northM / 111_320,
    longitude:
      position.longitude +
      eastM / (111_320 * Math.cos((position.latitude * Math.PI) / 180)),
    altitudeM: position.altitudeM + upM + forwardM * Math.sin(pitch),
  };
}

function percentile(values, fraction) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * fraction)),
  );
  return sorted[index];
}

function viewportForDimensions(width, height, longEdge = 960) {
  return width >= height
    ? {
        width: longEdge,
        height: Math.max(1, Math.round((longEdge * height) / width)),
      }
    : {
        width: Math.max(1, Math.round((longEdge * width) / height)),
        height: longEdge,
      };
}

async function refineFrustumFromSolvedView(page, record, solved) {
  const previousFrustum = solved.frustum;
  const viewport = viewportForDimensions(record.width, record.height);
  const columns = 13;
  const rows = 9;
  const margin = 0.025;
  const points = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => ({
      x:
        viewport.width * (margin + (column / (columns - 1)) * (1 - margin * 2)),
      y: viewport.height * (margin + (row / (rows - 1)) * (1 - margin * 2)),
    })),
  ).flat();
  await page.evaluate(
    (view) => window.__PHOTO_AUTO_CALIBRATION__.render(view),
    {
      position: solved.position,
      pose: solved.pose,
      optics: solved.optics,
      viewport,
    },
  );
  const picked = await page.evaluate(
    (samplePoints) => window.__PHOTO_AUTO_CALIBRATION__.pickDepth(samplePoints),
    points,
  );
  const rawDepths = picked
    .filter(Boolean)
    .map((point) => worldDistanceM(solved.position, point))
    .filter((distance) => Number.isFinite(distance) && distance > 0.1);
  let depths = rawDepths.filter((distance) => distance <= 50_000);
  const evidence = {
    method: "full-frame-provider-depth-grid",
    columns,
    rows,
    sampleCount: points.length,
    validDepthCount: depths.length,
    validDepthRatio: depths.length / points.length,
    nonCityDepthCount: rawDepths.length - depths.length,
  };
  if (depths.length < 12) return { accepted: false, ...evidence };
  let p02 = percentile(depths, 0.02);
  let p05 = percentile(depths, 0.05);
  let p50 = percentile(depths, 0.5);
  let p95 = percentile(depths, 0.95);
  let p98 = percentile(depths, 0.98);
  let drillRayEvidence;
  if (p98 < 30) {
    let secondaryDepths = [];
    let offsetProbeEvidence;
    if (
      solved.optics.horizontalFovDeg < 25 ||
      solved.optics.verticalFovDeg < 25
    ) {
      const minimumFovDeg = Math.min(
        solved.optics.horizontalFovDeg,
        solved.optics.verticalFovDeg,
      );
      const probes = [
        { forwardM: 5, upM: 2 },
        { forwardM: 15, upM: 5 },
        { forwardM: 30, upM: 10 },
        ...(minimumFovDeg < 25
          ? [
              { forwardM: 100, upM: 10 },
              { forwardM: 300, upM: 20 },
            ]
          : []),
        ...(minimumFovDeg < 10 ? [{ forwardM: 1_000, upM: 30 }] : []),
      ];
      const probeResults = [];
      for (const probe of probes) {
        const probePosition = offsetCameraPosition(
          solved.position,
          solved.pose,
          probe.forwardM,
          probe.upM,
        );
        await page.evaluate(
          (view) => window.__PHOTO_AUTO_CALIBRATION__.render(view),
          {
            position: probePosition,
            pose: solved.pose,
            optics: solved.optics,
            viewport,
          },
        );
        const probePicks = await page.evaluate(
          (samplePoints) =>
            window.__PHOTO_AUTO_CALIBRATION__.pickDepth(samplePoints),
          points,
        );
        const minimumSurfaceDistanceM =
          probe.forwardM + Math.max(50, probe.forwardM * 0.5);
        const probeDepths = probePicks
          .filter(Boolean)
          .map((point) => worldDistanceM(solved.position, point))
          .filter(
            (distance) =>
              Number.isFinite(distance) &&
              distance >= minimumSurfaceDistanceM &&
              distance <= 50_000,
          );

        probeResults.push({
          ...probe,
          position: probePosition,
          minimumSurfaceDistanceM,
          depths: probeDepths,
          p98: percentile(probeDepths, 0.98) ?? 0,
        });
      }
      probeResults.sort(
        (a, b) => b.p98 - a.p98 || b.depths.length - a.depths.length,
      );
      const bestProbe = probeResults[0];
      if (bestProbe?.depths.length >= 8) secondaryDepths = bestProbe.depths;
      offsetProbeEvidence = {
        attempts: probeResults.map(({ depths: values, ...probe }) => ({
          ...probe,
          secondaryDepthCount: values.length,
        })),
        accepted: secondaryDepths.length >= 8,
      };
    }
    const drillPoints = points.filter((_, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      return row % 4 === 0 && column % 3 === 0;
    });
    const minimumSecondaryDepthM = Math.max(30, p98 * 4);
    if (secondaryDepths.length < 8) {
      const drilled = await page.evaluate(
        (samplePoints) =>
          window.__PHOTO_AUTO_CALIBRATION__.drillPickDepth(samplePoints),
        drillPoints,
      );
      secondaryDepths = drilled
        .flat()
        .map((point) => worldDistanceM(solved.position, point))
        .filter(
          (distance) =>
            Number.isFinite(distance) &&
            distance >= minimumSecondaryDepthM &&
            distance <= 50_000,
        );
    }
    drillRayEvidence = {
      sampleCount: drillPoints.length,
      secondaryDepthCount: secondaryDepths.length,
      minimumSecondaryDepthM,
      ...(offsetProbeEvidence ? { offsetProbe: offsetProbeEvidence } : {}),
    };
    if (secondaryDepths.length < 8)
      return {
        accepted: false,
        ...evidence,
        rejectionReason: "provider-camera-occluded-by-near-geometry",
        percentilesM: { p02, p05, p50, p95, p98 },
        drillRay: drillRayEvidence,
      };
    depths = [...depths, ...secondaryDepths];
    p02 = percentile(depths, 0.02);
    p05 = percentile(depths, 0.05);
    p50 = percentile(depths, 0.5);
    p95 = percentile(depths, 0.95);
    p98 = percentile(depths, 0.98);
  }
  const providerOverridesConflict = providerDepthOverridesSolvedRange({
    previousNearM: previousFrustum?.nearM,
    previousFarM: previousFrustum?.farM,
    providerP98M: p98,
    validDepthRatio: evidence.validDepthRatio,
    secondaryDepthCount: drillRayEvidence?.secondaryDepthCount ?? 0,
  });
  if (
    providerDepthMissesSolvedSurfaces({
      previousFarM: previousFrustum?.farM,
      providerP02M: p02,
      providerP50M: p50,
    })
  )
    return {
      accepted: false,
      ...evidence,
      rejectionReason: "provider-depth-misses-solved-feature-surfaces",
      percentilesM: { p02, p05, p50, p95, p98 },
      ...(drillRayEvidence ? { drillRay: drillRayEvidence } : {}),
    };
  if (
    providerDepthTruncatesTrustedRange({
      previousNearM: previousFrustum?.nearM,
      previousFarM: previousFrustum?.farM,
      providerP98M: p98,
      providerOverridesConflict,
    })
  )
    return {
      accepted: false,
      ...evidence,
      rejectionReason: "provider-depth-truncates-trusted-feature-range",
      percentilesM: { p02, p05, p50, p95, p98 },
      ...(drillRayEvidence ? { drillRay: drillRayEvidence } : {}),
    };
  if (
    previousFrustum?.nearM >= 50 &&
    p98 < previousFrustum.nearM * 2 &&
    !providerOverridesConflict
  )
    return {
      accepted: false,
      ...evidence,
      rejectionReason: "provider-depth-conflicts-with-solved-feature-range",
      percentilesM: { p02, p05, p50, p95, p98 },
      ...(drillRayEvidence ? { drillRay: drillRayEvidence } : {}),
    };
  const nearM = Math.max(0.25, p02 * 0.2);
  const farM = Math.min(20_000, Math.max(30, p98 * 1.15));
  if (!(farM > nearM)) return { accepted: false, ...evidence };
  solved.frustum = { nearM, farM };
  return {
    accepted: true,
    ...evidence,
    percentilesM: { p02, p05, p50, p95, p98 },
    ...(drillRayEvidence ? { drillRay: drillRayEvidence } : {}),
    ...(providerOverridesConflict
      ? { conflictResolution: "provider-overrode-inflated-feature-range" }
      : {}),
    frustum: solved.frustum,
  };
}

async function elevationAt(latitude, longitude) {
  const cacheKey = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  if (elevationCache.has(cacheKey)) return elevationCache.get(cacheKey);
  const url = new URL("https://maps.googleapis.com/maps/api/elevation/json");
  url.searchParams.set("locations", `${latitude},${longitude}`);
  url.searchParams.set("key", googleKey);
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok || payload.status !== "OK" || !payload.results?.length)
    throw new Error(`Elevation lookup failed at ${cacheKey}.`);
  const meanSeaLevelM = payload.results[0].elevation + 2.5;
  const value = {
    meanSeaLevelM,
    ellipsoidM: meanSeaLevelM + geoidUndulationM(geoid, latitude, longitude),
    resolutionM: payload.results[0].resolution,
  };
  elevationCache.set(cacheKey, value);
  return value;
}

function referenceViews(
  metadata,
  optics,
  useFastSweep = false,
  useWideSweep = false,
) {
  if (metadata.imageOnly) {
    if (useWideSweep && metadata.refineViews?.length)
      return metadata.refineViews.flatMap((reference, referenceIndex) =>
        [-20, 0, 20].flatMap((headingOffset) =>
          [-15, 0, 15].map((pitchOffset) => {
            const headingDeg =
              (reference.pose.headingDeg + headingOffset + 360) % 360;
            const pitchDeg = Math.max(
              -60,
              Math.min(60, reference.pose.pitchDeg + pitchOffset),
            );
            return {
              id: `r${referenceIndex}-h${headingDeg.toFixed(1)}-p${pitchDeg.toFixed(1)}`.replaceAll(
                "-",
                "m",
              ),
              panoramaId: reference.panoramaId,
              pose: { headingDeg, pitchDeg, rollDeg: 0 },
              optics: { horizontalFovDeg: 90, verticalFovDeg: 90 },
            };
          }),
        ),
      );
    return Array.from({ length: 6 }, (_, index) => ({
      id: `h${index * 60}-p0`,
      pose: { headingDeg: index * 60, pitchDeg: 0, rollDeg: 0 },
      optics: { horizontalFovDeg: 90, verticalFovDeg: 90 },
    }));
  }
  const heading = numberFrom(metadata.headingDeg);
  const pitch = numberFrom(metadata.pitchDeg) ?? 0;
  const headings =
    heading === undefined
      ? Array.from(
          { length: useFastSweep ? 6 : 12 },
          (_, index) => index * (useFastSweep ? 60 : 30),
        )
      : (useWideSweep ? [-60, -30, 0, 30, 60] : [-30, 0, 30]).map(
          (offset) => (heading + offset + 360) % 360,
        );
  const pitchOffsets = useFastSweep ? [0] : [-15, 0, 15];
  return headings.flatMap((headingDeg) =>
    pitchOffsets.map((offset) => ({
      id: `h${headingDeg.toFixed(1)}-p${(pitch + offset).toFixed(1)}`.replaceAll(
        "-",
        "m",
      ),
      pose: {
        headingDeg,
        pitchDeg: Math.max(-60, Math.min(60, pitch + offset)),
        rollDeg: 0,
      },
      optics,
    })),
  );
}

async function streetViewReferences(record, views, directory) {
  if (!googleKey)
    throw new Error(
      "PUBLIC_GOOGLE_MAP_TILES_API_KEY is required for Street View localization.",
    );
  const primaryPriors = record.searchPriors?.primary ?? [record.prior];
  const fallbackPriors = record.searchPriors?.fallback ?? [];
  const discover = async (priors) => {
    const panoramas = new Map();
    for (const prior of priors) {
      const metadataUrl = new URL(
        "https://maps.googleapis.com/maps/api/streetview/metadata",
      );
      metadataUrl.searchParams.set(
        "location",
        `${prior.latitude},${prior.longitude}`,
      );
      metadataUrl.searchParams.set(
        "radius",
        String(record.panoramaRadiusM ?? 80),
      );
      metadataUrl.searchParams.set("source", "outdoor");
      metadataUrl.searchParams.set("key", googleKey);
      const metadataResponse = await fetch(metadataUrl);
      const panorama = await metadataResponse.json();
      if (metadataResponse.ok && panorama.status === "OK" && panorama.pano_id)
        panoramas.set(panorama.pano_id, panorama);
    }
    return [...panoramas.values()];
  };
  let panoramas = await discover(primaryPriors);
  if (!panoramas.length && fallbackPriors.length)
    panoramas = await discover(fallbackPriors);
  if (!panoramas.length)
    throw new Error(
      `${record.id}: no official outdoor Street View panorama within the bounded search area.`,
    );
  const references = [];
  for (const [panoramaIndex, panoramaRecord] of panoramas.entries()) {
    const panoramaElevation = await elevationAt(
      panoramaRecord.location.lat,
      panoramaRecord.location.lng,
    );
    for (const view of views) {
      if (view.panoramaId && view.panoramaId !== panoramaRecord.pano_id)
        continue;
      const imageUrl = new URL(
        "https://maps.googleapis.com/maps/api/streetview",
      );
      imageUrl.searchParams.set("size", "640x640");
      imageUrl.searchParams.set("scale", "2");
      imageUrl.searchParams.set("pano", panoramaRecord.pano_id);
      imageUrl.searchParams.set("heading", String(view.pose.headingDeg));
      imageUrl.searchParams.set("pitch", String(view.pose.pitchDeg));
      imageUrl.searchParams.set(
        "fov",
        String(Math.min(120, Math.max(10, view.optics.horizontalFovDeg))),
      );
      imageUrl.searchParams.set("key", googleKey);
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok)
        throw new Error(
          `${record.id}: Street View image request failed (${imageResponse.status}).`,
        );
      const referenceId = `p${panoramaIndex}-${view.id}`;
      const filename = path.join(directory, `${referenceId}.jpg`);
      await writeFile(filename, Buffer.from(await imageResponse.arrayBuffer()));
      const dimensions = await sharp(filename).metadata();
      const horizontalFovDeg = Math.min(
        120,
        Math.max(10, view.optics.horizontalFovDeg),
      );
      references.push({
        id: referenceId,
        path: filename,
        view: {
          position: {
            latitude: panoramaRecord.location.lat,
            longitude: panoramaRecord.location.lng,
            altitudeM: panoramaElevation.ellipsoidM,
          },
          pose: view.pose,
          optics: {
            horizontalFovDeg,
            verticalFovDeg: horizontalFovDeg,
          },
          viewport: { width: dimensions.width, height: dimensions.height },
        },
        panorama: {
          id: panoramaRecord.pano_id,
          date: panoramaRecord.date,
          latitude: panoramaRecord.location.lat,
          longitude: panoramaRecord.location.lng,
          copyright: panoramaRecord.copyright,
        },
      });
    }
  }
  return references;
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child && child.exitCode !== null)
      throw new Error("Astro calibration server exited early.");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function pythonJson(script, request, extra = []) {
  const requestPath = path.join(
    path.dirname(request.outputPath),
    `${path.basename(script, ".py")}-request.json`,
  );
  await writeFile(requestPath, `${JSON.stringify(request.payload, null, 2)}\n`);
  const { stdout } = await run(
    venvPython,
    [
      path.join(root, "scripts/photography/calibration", script),
      requestPath,
      ...extra,
    ],
    {
      capture: true,
      privateOutput: true,
    },
  );
  const lines = stdout.trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1));
}

async function openCalibrationSession() {
  await access(venvPython).catch(() => {
    throw new Error(
      "Calibration environment is missing. Run `npm run photos:setup` first.",
    );
  });
  const { chromium } = await import("@playwright/test");
  let server;
  if (!serverArg || spawnServer)
    server = spawn(
      process.execPath,
      [
        path.join(root, "node_modules/astro/bin/astro.mjs"),
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        new URL(serverUrl).port || "4322",
      ],
      { cwd: root, stdio: "ignore", env: process.env },
    );
  let browser;
  try {
    await waitForServer(`${serverUrl}/photography/auto-calibration`, server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 960 },
      deviceScaleFactor: 1,
    });
    await page.goto(`${serverUrl}/photography/auto-calibration`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () => document.documentElement.dataset.autoCalibrationReady === "true",
      undefined,
      { timeout: 30_000 },
    );
    return {
      activeCity: undefined,
      browser,
      page,
      referenceCache: new Map(),
      referenceDirectories: new Set(),
      server,
    };
  } catch (error) {
    await browser?.close();
    server?.kill();
    throw error;
  }
}

async function closeCalibrationSession(session) {
  try {
    await Promise.all(
      [...session.referenceDirectories].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
    await session.browser?.close();
  } finally {
    session.server?.kill();
  }
}

async function ensureCalibrationSession(session) {
  if (session.page) return session.page;
  if (session.error) throw session.error;
  let opened;
  try {
    opened = await openCalibrationSession();
  } catch (error) {
    session.error = error;
    throw error;
  }
  session.browser = opened.browser;
  session.page = opened.page;
  session.server = opened.server;
  session.activeCity = opened.activeCity;
  return session.page;
}

async function calibrate(
  records,
  options = {
    fastSweep: false,
    wideSweep: false,
    featureType: "superpoint",
  },
  session,
  updateActivity = () => {},
) {
  if (!records.length) return [];
  const results = [];
  for (const record of records) {
    updateActivity(`${record.id} (${record.cityId})`);
    const directory = path.join(workRoot, record.id);
    const sweepKey = options.wideSweep
      ? "wide"
      : options.fastSweep
        ? "fast"
        : "standard";
    const referenceKey = `${record.id}:${sweepKey}`;
    const referencesDirectory = path.join(directory, `references-${sweepKey}`);
    try {
      await mkdir(referencesDirectory, { recursive: true });
      session.referenceDirectories.add(referencesDirectory);
      const optics = record.imageOnly
        ? { horizontalFovDeg: 90, verticalFovDeg: 90 }
        : fovFrom35mm(
            record.focalLength35Mm ?? 28,
            record.width,
            record.height,
          );
      const views = referenceViews(
        record,
        optics,
        options.fastSweep,
        options.wideSweep,
      );
      let references = session.referenceCache.get(referenceKey);
      if (!references) {
        references = await streetViewReferences(
          record,
          views,
          referencesDirectory,
        );
        session.referenceCache.set(referenceKey, references);
      }
      let rankedReferences = references;
      if (record.imageOnly) {
        const ranking = await pythonJson("rank_references.py", {
          outputPath: directory,
          payload: {
            query: record.queryPath,
            references: references.map(({ id, path: filename }) => ({
              id,
              path: filename,
            })),
            limit: 24,
          },
        });
        const scoreById = new Map(
          (ranking.ranked ?? []).map((item) => [item.id, item.score]),
        );
        rankedReferences = references
          .filter((reference) => scoreById.has(reference.id))
          .sort(
            (left, right) => scoreById.get(right.id) - scoreById.get(left.id),
          );
      }
      const matcherFeature = options.featureType;
      const match = await pythonJson("match_images.py", {
        outputPath: directory,
        payload: {
          query: record.queryPath,
          references: rankedReferences.map(({ id, path: filename }) => ({
            id,
            path: filename,
          })),
          maxKeypoints: matcherFeature === "superpoint" ? 2048 : 4096,
          featureType: matcherFeature,
          candidateLimit: record.imageOnly ? 24 : 3,
        },
      });
      if (match.error) throw new Error(match.error);
      const candidateSolutions = [];
      const geometricCandidates = match.candidates.filter(
        (item) => item.geometricInliers >= 8,
      );
      let page;
      if (geometricCandidates.length) {
        page = await ensureCalibrationSession(session);
        if (session.activeCity !== record.cityId) {
          await page.evaluate(
            (cityId) => window.__PHOTO_AUTO_CALIBRATION__.loadCity(cityId),
            record.cityId,
          );
          session.activeCity = record.cityId;
        }
      }
      for (const candidate of geometricCandidates) {
        const reference = references.find((item) => item.id === candidate.id);
        const poseQueryPoints = candidate.queryPoints;
        const poseReferencePoints = candidate.referencePoints;
        await page.evaluate(
          (value) => window.__PHOTO_AUTO_CALIBRATION__.render(value),
          reference.view,
        );
        const picked = await page.evaluate(
          (points) =>
            window.__PHOTO_AUTO_CALIBRATION__.pick(
              points.map(([x, y]) => ({ x, y })),
            ),
          poseReferencePoints,
        );
        const imagePoints = [];
        const worldPoints = [];
        poseQueryPoints.forEach((point, index) => {
          if (picked[index]) {
            imagePoints.push(point);
            worldPoints.push(picked[index]);
          }
        });
        const fovHypotheses = record.imageOnly
          ? [35, 55, 80]
          : [optics.horizontalFovDeg];
        const focalSolutions = [];
        for (const horizontalFovDeg of fovHypotheses) {
          let solved;
          try {
            solved = await pythonJson("solve_pose.py", {
              outputPath: directory,
              payload: {
                imageSize: { width: record.width, height: record.height },
                horizontalFovDeg,
                prior: record.imageOnly
                  ? {
                      ...reference.view.position,
                      horizontalAccuracyM: record.maximumPanoramaDistanceM / 4,
                      coarse: true,
                    }
                  : record.prior,
                imagePoints,
                worldPoints,
              },
            });
          } catch (error) {
            solved = {
              accepted: false,
              rejectionReasons: ["absolute-pose-solver-failed"],
              metrics: {
                matches: imagePoints.length,
                inliers: 0,
                inlierRatio: 0,
                rmsErrorPx: null,
                imageCoverage: 0,
                positionDeltaM: null,
              },
              error: error instanceof Error ? error.message : String(error),
            };
          }
          if (
            record.imageOnly &&
            solved.accepted &&
            (solved.optics.horizontalFovDeg < 20 ||
              solved.optics.horizontalFovDeg > 110)
          ) {
            solved.accepted = false;
            solved.rejectionReasons = ["refined-fov-outside-20-to-110-degrees"];
          }
          focalSolutions.push(solved);
        }
        focalSolutions.sort(
          (left, right) =>
            Number(right.accepted) - Number(left.accepted) ||
            (right.metrics?.inliers ?? 0) - (left.metrics?.inliers ?? 0) ||
            (left.metrics?.rmsErrorPx ?? Number.POSITIVE_INFINITY) -
              (right.metrics?.rmsErrorPx ?? Number.POSITIVE_INFINITY),
        );
        let solved = focalSolutions[0];
        if (!record.imageOnly && !solved.accepted) {
          try {
            const rotation = await pythonJson("solve_rotation.py", {
              outputPath: directory,
              payload: {
                querySize: { width: record.width, height: record.height },
                referenceSize: reference.view.viewport,
                queryHorizontalFovDeg: optics.horizontalFovDeg,
                referenceHorizontalFovDeg:
                  reference.view.optics.horizontalFovDeg,
                referencePose: reference.view.pose,
                prior: record.prior,
                minimumInliers: 12,
                preferHomographyPose: false,
                queryPoints: candidate.queryPoints,
                referencePoints: candidate.referencePoints,
              },
            });
            if (rotation.accepted) {
              if (record.rollDeg !== undefined)
                rotation.pose.rollDeg = record.rollDeg;
              const depths = worldPoints
                .map((point) => worldDistanceM(rotation.position, point))
                .filter((distance) => Number.isFinite(distance));
              if (depths.length >= 4)
                rotation.frustum = {
                  nearM: Math.max(0.25, percentile(depths, 0.05) * 0.25),
                  farM: Math.min(
                    20_000,
                    Math.max(30, percentile(depths, 0.95) * 1.35),
                  ),
                };
              solved = rotation;
            }
          } catch {
            // Preserve the stronger absolute-pose failure evidence.
          }
        }
        candidateSolutions.push({
          reference: candidate.id,
          referencePosition: reference.view.position,
          solved,
          focalSolutions,
        });
        if (
          solved.accepted &&
          solved.solutionMode === "absolute-pose" &&
          solved.metrics.inliers >= 20 &&
          solved.metrics.imageCoverage >= 0.08 &&
          solved.metrics.rmsErrorPx <= 4
        )
          break;
      }
      candidateSolutions.sort(
        (a, b) =>
          Number(b.solved.accepted) - Number(a.solved.accepted) ||
          b.solved.metrics.inliers - a.solved.metrics.inliers ||
          b.solved.metrics.inlierRatio - a.solved.metrics.inlierRatio ||
          b.solved.metrics.imageCoverage - a.solved.metrics.imageCoverage,
      );
      const best = candidateSolutions[0] ?? {
        reference: "",
        solved: {
          accepted: false,
          rejectionReasons: ["no-reference-produced-enough-depth-picks"],
          metrics: {
            matches: 0,
            inliers: 0,
            inlierRatio: 0,
            rmsErrorPx: null,
            imageCoverage: 0,
            positionDeltaM: null,
          },
        },
      };
      const { solved } = best;
      if (record.imageOnly && solved.accepted) {
        const validation = validateImageOnlySolution({
          solved,
          panoramaPosition: best.referencePosition,
          bounds: record.bounds,
          maximumPanoramaDistanceM: record.maximumPanoramaDistanceM,
          competingSolutions: candidateSolutions
            .filter((candidate) => candidate !== best)
            .map((candidate) => candidate.solved),
        });
        if (!validation.accepted) {
          solved.accepted = false;
          solved.rejectionReasons = validation.rejectionReasons;
        }
      }
      const bestReference = best.reference;
      let frustumDepthEvidence;
      if (solved.accepted) {
        solved.featureFrustum = { ...solved.frustum };
        try {
          frustumDepthEvidence = await refineFrustumFromSolvedView(
            page,
            record,
            solved,
          );
        } catch (error) {
          frustumDepthEvidence = {
            accepted: false,
            method: "full-frame-provider-depth-grid",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        solved.frustumDepthEvidence = frustumDepthEvidence;
      }
      const evidence = {
        id: record.id,
        cityId: record.cityId,
        matcher: match.matcher,
        bestReference,
        solved,
        panorama: references[0]?.panorama,
        candidateSolutions,
        frustumDepthEvidence,
        referencePositions: [
          ...new Map(
            references.map((reference) => [
              JSON.stringify(reference.view.position),
              reference.view.position,
            ]),
          ).values(),
        ],
      };
      await writeFile(
        path.join(directory, "evidence.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
      results.push({
        record,
        match,
        solved,
        bestReference,
        rankedReferenceViews: rankedReferences.slice(0, 6).map((reference) => ({
          panoramaId: reference.panorama.id,
          pose: reference.view.pose,
        })),
      });
    } catch (error) {
      const solved = {
        accepted: false,
        rejectionReasons: ["reference-or-provider-unavailable"],
        metrics: {
          matches: 0,
          inliers: 0,
          inlierRatio: 0,
          rmsErrorPx: null,
          imageCoverage: 0,
          positionDeltaM: null,
        },
        error: error instanceof Error ? error.message : String(error),
      };
      const match = { matcher: "unavailable" };
      const bestReference = "";
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "evidence.json"),
        `${JSON.stringify(
          {
            id: record.id,
            cityId: record.cityId,
            matcher: match.matcher,
            bestReference,
            solved,
          },
          null,
          2,
        )}\n`,
      );
      results.push({
        record,
        match,
        solved,
        bestReference,
        terminalFailure: Boolean(session.error),
      });
    }
  }
  return results;
}

function describeCalibrationStage(options) {
  const sweep = options.wideSweep
    ? "wide sweep"
    : options.fastSweep
      ? "fast sweep"
      : "standard sweep";
  return `${options.referenceSource}/${options.featureType}, ${sweep}`;
}

async function calibrateWithProgress(records, options, stageLabel, session) {
  if (!records.length) {
    console.log(`${stageLabel ?? "Calibration"}: no target photos.`);
    return [];
  }
  const resolvedOptions = options ?? {
    fastSweep: false,
    wideSweep: false,
    referenceSource: "street-view",
    featureType: "superpoint",
  };
  const description = describeCalibrationStage(resolvedOptions);
  return withActivity(
    {
      label: stageLabel ?? "Calibration",
      detail: `${description}; ${records.length} pending`,
    },
    (updateActivity) =>
      calibrate(records, resolvedOptions, session, (detail) =>
        updateActivity(`${description}; ${detail}`),
      ),
  );
}

async function calibrateAdaptively(records) {
  const byId = new Map();
  const imageOnly = records.every((record) => record.imageOnly);
  const stages = imageOnly
    ? [
        {
          fastSweep: true,
          wideSweep: false,
          referenceSource: "street-view",
          featureType: "superpoint",
        },
        {
          fastSweep: false,
          wideSweep: true,
          referenceSource: "street-view-refinement",
          featureType: "aliked",
        },
      ]
    : [
        {
          fastSweep: true,
          wideSweep: false,
          referenceSource: "street-view",
          featureType: "superpoint",
        },
        {
          fastSweep: false,
          wideSweep: true,
          referenceSource: "street-view",
          featureType: "superpoint",
        },
        {
          fastSweep: true,
          wideSweep: false,
          referenceSource: "street-view",
          featureType: "aliked",
        },
      ];
  let pending = records;
  const session = imageOnly
    ? {
        activeCity: undefined,
        browser: undefined,
        page: undefined,
        referenceCache: new Map(),
        referenceDirectories: new Set(),
        server: undefined,
      }
    : await openCalibrationSession();
  try {
    for (const [stageIndex, stage] of stages.entries()) {
      if (!pending.length) break;
      const stageResults = await calibrateWithProgress(
        pending,
        stage,
        `Adaptive calibration ${stageIndex + 1}/${stages.length}`,
        session,
      );
      for (const result of stageResults) byId.set(result.record.id, result);
      if (imageOnly)
        for (const result of stageResults)
          if (!result.solved.accepted && result.rankedReferenceViews?.length)
            result.record.refineViews = result.rankedReferenceViews;
      const acceptedIds = new Set(
        stageResults
          .filter(
            (result) =>
              result.solved.accepted &&
              isPublishingMatcher(result.match.matcher),
          )
          .map((result) => result.record.id),
      );
      const terminalIds = new Set(
        stageResults
          .filter((result) => result.terminalFailure)
          .map((result) => result.record.id),
      );
      pending = pending.filter(
        (record) => !acceptedIds.has(record.id) && !terminalIds.has(record.id),
      );
    }
  } finally {
    await closeCalibrationSession(session);
  }
  return records.map((record) => byId.get(record.id));
}

if (setup) {
  await setupEnvironment();
  console.log("Automatic calibration environment is ready.");
  process.exit(0);
}

if (!calibrateIds.length && !imageOnlyRequestPath)
  throw new Error(
    "The internal map worker requires --calibrate-ids=<id[,id...]>.",
  );

await assertCalibrationPrerequisites({ persistModelMarker: false });
await mkdir(workRoot, { recursive: true });

const imageOnlyRequest = imageOnlyRequestPath
  ? JSON.parse(await readFile(imageOnlyRequestPath, "utf8"))
  : undefined;
if (imageOnlyRequest?.workRoot) workRoot = imageOnlyRequest.workRoot;
console.log(
  imageOnlyRequest
    ? "Loading image-only localization request; private metadata is unavailable to this worker..."
    : "Loading photography manifest and private calibration metadata...",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const metadata = imageOnlyRequest
  ? undefined
  : JSON.parse(await readFile(metadataPath, "utf8"));
const targets = [
  ...new Set(
    imageOnlyRequest
      ? imageOnlyRequest.records.map((record) => record.id)
      : calibrateIds,
  ),
];
for (const id of targets)
  if (!manifest.some((photo) => photo.id === id))
    throw new Error("Unknown photography calibration target: " + id);

console.log(
  "Selected " +
    targets.length +
    " calibration target" +
    (targets.length === 1 ? "." : "s."),
);
console.log("Loading EGM96 geoid data...");
const geoid = await readGeoidPgm(geoidPath);
const calibrationRecords = [];
const preflightResults = [];
const progress = createProgressReporter({
  total: targets.length,
  label: "Preparing calibration target",
});

try {
  if (imageOnlyRequest) {
    for (const record of imageOnlyRequest.records) {
      if (
        !record.imageOnly ||
        record.cityId !== imageOnlyRequest.cityId ||
        record.experimentId !== imageOnlyRequest.experimentId ||
        !record.queryPath ||
        !record.pixelDigest ||
        !record.searchPriors?.primary?.length
      )
        throw new Error(`${record.id}: invalid image-only worker request.`);
      const queryMetadata = await sharp(record.queryPath).metadata();
      if (!queryMetadata.width || !queryMetadata.height)
        throw new Error(`${record.id}: sanitized pixels have no dimensions.`);
      calibrationRecords.push({
        ...record,
        country: imageOnlyRequest.country,
        width: queryMetadata.width,
        height: queryMetadata.height,
        prior: {
          ...record.searchPriors.primary[0],
          altitudeM: 0,
          horizontalAccuracyM: record.maximumPanoramaDistanceM / 4,
          coarse: true,
        },
      });
    }
  } else
    for (const [targetIndex, id] of targets.entries()) {
      progress.update(targetIndex + 1, id);
      const image = manifest.find((item) => item.id === id);
      const exact = metadata.find((item) => item.id === id);
      const city =
        (exact?.gps
          ? cityForGps(cities, exact.gps.latitude, exact.gps.longitude)
          : undefined) ??
        cities.find(
          (candidate) =>
            candidate.country === exact?.country &&
            candidate.region === exact?.region,
        );
      if (!image || !exact || !city)
        throw new Error(
          id + ": manifest, private metadata, or configured city is missing.",
        );
      if (!exact.gps) {
        preflightResults.push({
          record: { id, cityId: city.id },
          match: { matcher: "unavailable" },
          bestReference: "",
          solved: {
            accepted: false,
            rejectionReasons: ["exact-gps-required-for-map-calibration"],
            metrics: {
              matches: 0,
              inliers: 0,
              inlierRatio: 0,
              rmsErrorPx: null,
              imageCoverage: 0,
              positionDeltaM: null,
            },
          },
        });
        continue;
      }

      const undulation = geoidUndulationM(
        geoid,
        exact.gps.latitude,
        exact.gps.longitude,
      );
      const prior = {
        longitude: exact.gps.longitude,
        latitude: exact.gps.latitude,
        altitudeM: exact.gps.altitudeM + undulation,
        horizontalAccuracyM: exact.gps.horizontalAccuracyM ?? 10,
        coarse: false,
      };
      const queryPath = path.join(
        root,
        "public",
        image.variants.at(-1).src.replace(/^\//, ""),
      );
      const queryMetadata = await sharp(queryPath).metadata();
      if (!queryMetadata.width || !queryMetadata.height)
        throw new Error(
          id + ": generated calibration image has no dimensions.",
        );
      calibrationRecords.push({
        ...exact,
        id,
        cityId: city.id,
        country: city.country,
        image,
        prior,
        queryPath,
        width: queryMetadata.width,
        height: queryMetadata.height,
        geoidUndulationM: undulation,
      });
    }
} finally {
  progress.finish();
}

calibrationRecords.sort(
  (left, right) =>
    left.cityId.localeCompare(right.cityId) || left.id.localeCompare(right.id),
);
const solvedCalibrationResults = await calibrateAdaptively(calibrationRecords);
const calibrationResults = [...preflightResults, ...solvedCalibrationResults];

if (imageOnlyRequest) {
  if (!imageOnlyRequest.resultPath)
    throw new Error("The image-only request is missing a private result path.");
  const output = calibrationResults.map(
    ({ record, match, solved, bestReference, rankedReferenceViews }) => ({
      id: record.id,
      cityId: record.cityId,
      experimentId: record.experimentId,
      pixelDigest: record.pixelDigest,
      pixelRotationDeg: record.pixelRotationDeg,
      matcher: match.matcher,
      bestReference,
      rankedReferenceViews: rankedReferenceViews?.length ?? 0,
      solved,
    }),
  );
  await writeFile(
    imageOnlyRequest.resultPath,
    `${JSON.stringify(output, null, 2)}\n`,
  );
  console.log(
    `Image-only localization worker completed ${output.length} sealed-pixel target${output.length === 1 ? "" : "s"}.`,
  );
  process.exit(0);
}

console.log("Persisting automatic calibration candidates and rejections...");
const existingPilots = JSON.parse(
  await readFile(automaticPilotsPath, "utf8"),
).filter((seed) => !replaceCalibration || !targets.includes(seed.id));
let rejections = [];
try {
  rejections = JSON.parse(await readFile(automaticRejectionsPath, "utf8"));
} catch {}
const rejectionsById = new Map(
  rejections.map((rejection) => [rejection.id, rejection]),
);

for (const { record, match, solved, bestReference } of calibrationResults) {
  const accepted = solved.accepted && isPublishingMatcher(match.matcher);
  if (!accepted) {
    const cameraCandidate =
      cameraCandidateFromSolved(solved) ??
      rejectionsById.get(record.id)?.cameraCandidate;
    rejectionsById.set(record.id, {
      id: record.id,
      cityId: record.cityId,
      rejectionReasons: solved.rejectionReasons ?? ["not-publishable"],
      ...(cameraCandidate ? { cameraCandidate } : {}),
    });
    continue;
  }

  const confidence = Math.min(
    0.99,
    0.55 +
      solved.metrics.inlierRatio * 0.25 +
      solved.metrics.imageCoverage * 0.2,
  );
  const seed = {
    id: record.id,
    cityId: record.cityId,
    country: record.country,
    location: {
      latitude: record.prior.latitude,
      longitude: record.prior.longitude,
      altitudeM: record.gps.altitudeM,
    },
    originalAltitudeReference: "mean-sea-level",
    geoidUndulationM: record.geoidUndulationM,
    horizontalAccuracyM: record.gps.horizontalAccuracyM,
    corrected: {
      longitude: solved.position.longitude,
      latitude: solved.position.latitude,
      altitudeM: solved.position.altitudeM,
    },
    headingDeg: solved.pose.headingDeg,
    pitchDeg: solved.pose.pitchDeg,
    rollDeg:
      solved.solutionMode?.startsWith("bearing-rotation") &&
      record.rollDeg !== undefined
        ? record.rollDeg
        : solved.pose.rollDeg,
    focalLengthMm: record.focalLengthMm,
    focalLength35Mm: record.focalLength35Mm,
    horizontalFovDeg: solved.optics.horizontalFovDeg,
    verticalFovDeg: solved.optics.verticalFovDeg,
    source: "computer-vision",
    confidence,
    calibration: "calibrated",
    preferredTier: "photorealistic",
    nearM: solved.frustum.nearM,
    farM: solved.frustum.farM,
    automaticEvidence: {
      matcher: match.matcher,
      matches: solved.metrics.matches,
      inliers: solved.metrics.inliers,
      inlierRatio: solved.metrics.inlierRatio,
      rmsErrorPx: solved.metrics.rmsErrorPx,
      imageCoverage: solved.metrics.imageCoverage,
      positionDeltaM: solved.metrics.positionDeltaM,
      referenceView: bestReference,
      solutionMode: solved.solutionMode,
      ...(solved.frustumDepthEvidence
        ? { frustumDepth: solved.frustumDepthEvidence }
        : {}),
    },
  };
  const index = existingPilots.findIndex((item) => item.id === seed.id);
  if (index >= 0) existingPilots[index] = seed;
  else existingPilots.push(seed);
  rejectionsById.set(record.id, {
    id: record.id,
    cityId: record.cityId,
    rejectionReasons: ["pending-exact-render-overlay-audit"],
    cameraCandidate: cameraCandidateFromSeed(seed),
  });
}

await Promise.all([
  writeFile(
    automaticPilotsPath,
    JSON.stringify(existingPilots, null, 2) + "\n",
  ),
  writeFile(
    automaticRejectionsPath,
    JSON.stringify([...rejectionsById.values()], null, 2) + "\n",
  ),
]);

const acceptedIds = calibrationResults
  .filter(
    ({ match, solved }) =>
      solved.accepted && isPublishingMatcher(match.matcher),
  )
  .map(({ record }) => record.id);
let overlayAuditError;
if (acceptedIds.length) {
  try {
    await withActivity(
      {
        label: "Exact-render overlay audit",
        detail:
          acceptedIds.length +
          " accepted photo" +
          (acceptedIds.length === 1 ? "" : "s"),
      },
      () =>
        run(
          process.execPath,
          [
            path.join(root, "scripts/photography/verify-map.mjs"),
            "--ids=" + acceptedIds.join(","),
            "--repair",
            "--write-repairs",
            "--apply-rejections",
            "--strict",
          ],
          { capture: true, privateOutput: true },
        ),
    );
  } catch (error) {
    overlayAuditError = error;
    console.warn(
      "Exact-render verification did not publish every calibration candidate.",
    );
  }
} else {
  console.log("Exact-render overlay audit: no accepted candidates.");
}

const [finalPilots, finalRejections] = await Promise.all([
  readFile(automaticPilotsPath, "utf8").then(JSON.parse),
  readFile(automaticRejectionsPath, "utf8").then(JSON.parse),
]);
const finalRejectionIds = new Set(finalRejections.map((item) => item.id));
const verifiedPilots = finalPilots.filter(
  (item) =>
    item.automaticEvidence?.overlayAudit && !finalRejectionIds.has(item.id),
);
if (JSON.stringify(verifiedPilots) !== JSON.stringify(finalPilots))
  await writeFile(
    automaticPilotsPath,
    JSON.stringify(verifiedPilots, null, 2) + "\n",
  );

const finalPilotById = new Map(verifiedPilots.map((item) => [item.id, item]));
const finalRejectionById = new Map(
  finalRejections.map((item) => [item.id, item]),
);
const finalReport = calibrationResults.map(
  ({ record, match, solved, bestReference }) => {
    const pilot = finalPilotById.get(record.id);
    const rejection = finalRejectionById.get(record.id);
    const mapPublished = Boolean(
      pilot?.automaticEvidence?.overlayAudit && !rejection,
    );
    return {
      id: record.id,
      cityId: record.cityId,
      matcher: match.matcher,
      bestReference,
      galleryPublished: manifest.some((photo) => photo.id === record.id),
      mapStatus: mapPublished ? "accepted" : "rejected",
      mapPublished,
      candidateVisible: Boolean(rejection?.cameraCandidate),
      metrics: solved.metrics,
      rejectionReasons:
        rejection?.rejectionReasons ??
        solved.rejectionReasons ??
        (mapPublished ? [] : ["exact-render-verification-failed"]),
      ...(!mapPublished
        ? {
            retryCommand:
              "npm run photos -- --calibrate-ids=" +
              record.id +
              " --replace-calibration",
          }
        : {}),
    };
  },
);
await writeFile(
  path.join(workRoot, "report.json"),
  JSON.stringify(finalReport, null, 2) + "\n",
);
console.log(JSON.stringify(finalReport, null, 2));
if (overlayAuditError || finalReport.some((item) => !item.mapPublished))
  console.warn(
    "One or more photos remain unverified; complete camera candidates are still visible with warnings.",
  );
