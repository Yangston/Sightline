import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import {
  classifyOverlayResidual,
  normalizedOverlayResidual,
  overlayRunCanMutate,
  providerRenderStatsUsable,
} from "./lib/overlay-residual.mjs";
import { finalizeOverlayResult } from "./lib/map-verification.mjs";
import { cameraCandidateFromOverlayResult } from "./lib/camera-candidate.mjs";

const root = process.cwd();
const cliArgs = process.argv.slice(2);
const argumentValue = (name) =>
  cliArgs.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const workRoot =
  argumentValue("--work-root") ??
  path.join(root, ".private/photo-overlay-audit");
const reportPath =
  argumentValue("--report-path") ??
  path.join(root, ".private/photo-overlay-audit-report.json");
const rejectionBackupPath = path.join(
  root,
  ".private/photo-overlay-audit-rejections-before.json",
);
const pilotsPath =
  argumentValue("--pilots-path") ??
  path.join(root, "src/data/photography-auto-pilots.json");
const rejectionsPath = path.join(
  root,
  "src/data/photography-auto-rejections.json",
);
const venvPython = path.join(
  root,
  ".venv-photo-calibration",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const queryMapPath = argumentValue("--query-map");
const flags = new Set(cliArgs);
const strict = flags.has("--strict");
const repair = flags.has("--repair");
const writeRepairs = flags.has("--write-repairs");
const applyRejections = flags.has("--apply-rejections");
const rollbackLastApplication = flags.has("--rollback-last-application");
const citiesArgument = process.argv.find((value) =>
  value.startsWith("--cities="),
);
const idsArgument = process.argv.find((value) => value.startsWith("--ids="));
const selectedCities = new Set(
  citiesArgument?.split("=")[1].split(",").filter(Boolean) ?? [],
);
const selectedIds = new Set(
  idsArgument?.split("=")[1].split(",").filter(Boolean) ?? [],
);
const serverUrl = argumentValue("--server-url") ?? "http://127.0.0.1:4324";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      windowsHide: true,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${code}).\n${stderr}`,
          ),
        );
    });
  });
}

async function waitForServer(server) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null)
      throw new Error("Astro overlay-audit server exited early.");
    try {
      const response = await fetch(`${serverUrl}/photography/auto-calibration`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the overlay-audit server.");
}

function viewportFor(width, height, longEdge = 960) {
  return width >= height
    ? { width: longEdge, height: Math.round((longEdge * height) / width) }
    : { width: Math.round((longEdge * width) / height), height: longEdge };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * fraction)),
  );
  return sorted[index];
}

function worldDistanceM(origin, target) {
  const radiusM = 6_371_008.8;
  const latitude1 = (origin.latitude * Math.PI) / 180;
  const latitude2 = (target.latitude * Math.PI) / 180;
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta =
    ((target.longitude - origin.longitude) * Math.PI) / 180;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(longitudeDelta / 2) ** 2;
  const horizontalM =
    2 * radiusM * Math.asin(Math.min(1, Math.sqrt(haversine)));
  return Math.hypot(
    horizontalM,
    (target.altitudeM ?? 0) - (origin.altitudeM ?? 0),
  );
}

async function measureProviderFrustum(page, position, viewport) {
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
  const picked = await page.evaluate(
    (samplePoints) => window.__PHOTO_AUTO_CALIBRATION__.pickDepth(samplePoints),
    points,
  );
  const depths = picked
    .filter(Boolean)
    .map((point) => worldDistanceM(position, point))
    .filter(
      (distance) =>
        Number.isFinite(distance) && distance > 0.1 && distance <= 50_000,
    );
  const evidence = {
    accepted: depths.length >= 12,
    method: "full-frame-provider-depth-grid",
    columns,
    rows,
    sampleCount: points.length,
    validDepthCount: depths.length,
    validDepthRatio: depths.length / points.length,
    nonCityDepthCount: 0,
  };
  if (!evidence.accepted) return evidence;
  const percentilesM = {
    p02: percentile(depths, 0.02),
    p05: percentile(depths, 0.05),
    p50: percentile(depths, 0.5),
    p95: percentile(depths, 0.95),
    p98: percentile(depths, 0.98),
  };
  return {
    ...evidence,
    percentilesM,
    frustum: {
      nearM: Math.max(0.25, percentilesM.p02 * 0.2),
      farM: Math.min(20_000, Math.max(30, percentilesM.p98 * 1.15)),
    },
  };
}

function spatiallyBalancedIndices(points, viewport, limit = 120) {
  if (points.length <= limit) return points.map((_, index) => index);
  const gridSize = Math.ceil(Math.sqrt(limit));
  const buckets = new Map();
  points.forEach(([x, y], index) => {
    const column = Math.min(
      gridSize - 1,
      Math.max(0, Math.floor((x / viewport.width) * gridSize)),
    );
    const row = Math.min(
      gridSize - 1,
      Math.max(0, Math.floor((y / viewport.height) * gridSize)),
    );
    const key = `${column}:${row}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(index);
    buckets.set(key, bucket);
  });
  const selected = [];
  const values = [...buckets.values()];
  for (let depth = 0; selected.length < limit; depth += 1) {
    let added = false;
    for (const bucket of values) {
      if (bucket[depth] === undefined) continue;
      selected.push(bucket[depth]);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
}

async function matchOverlay(queryPath, providerPath, directory, featureType) {
  const requestPath = path.join(directory, `request-${featureType}.json`);
  await writeFile(
    requestPath,
    `${JSON.stringify(
      {
        query: queryPath,
        references: [{ id: "match-camera-provider", path: providerPath }],
        maxKeypoints: 8192,
        featureType,
        candidateLimit: 3,
      },
      null,
      2,
    )}\n`,
  );
  const { stdout } = await run(venvPython, [
    path.join(root, "scripts/photography/calibration/match_images.py"),
    requestPath,
  ]);
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}

async function assertProviderRenderUsable(providerPath) {
  const stats = await sharp(providerPath).stats();
  if (!providerRenderStatsUsable(stats))
    throw new Error("provider-render-unavailable");
}

async function bestOverlayMatch(queryPath, providerPath, directory) {
  const matches = [];
  for (const featureType of ["superpoint", "aliked"]) {
    const match = await matchOverlay(
      queryPath,
      providerPath,
      directory,
      featureType,
    );
    matches.push(match);
    if ((match.candidates[0]?.geometricInliers ?? 0) >= 12) break;
  }
  return matches.sort(
    (a, b) =>
      (b.candidates[0]?.geometricInliers ?? 0) -
      (a.candidates[0]?.geometricInliers ?? 0),
  )[0];
}

async function renderAuditView(page, view) {
  await page.evaluate(
    (candidate) => window.__PHOTO_AUTO_CALIBRATION__.render(candidate),
    view,
  );
  // A fresh city load stabilizes its default camera first. Repeating the exact
  // photo camera gives photogrammetry tiles time to refine at that location.
  await page.evaluate(
    (candidate) => window.__PHOTO_AUTO_CALIBRATION__.render(candidate),
    view,
  );
}

async function solveOverlayPose({
  seed,
  queryMetadata,
  queryPoints,
  referencePoints,
  viewport,
  directory,
  page,
}) {
  const indices = spatiallyBalancedIndices(referencePoints, viewport);
  const selectedReferencePoints = indices.map(
    (index) => referencePoints[index],
  );
  const selectedQueryPoints = indices.map((index) => queryPoints[index]);
  const picked = await page.evaluate(
    (points) => window.__PHOTO_AUTO_CALIBRATION__.pickDepth(points),
    selectedReferencePoints.map(([x, y]) => ({ x, y })),
  );
  const imagePoints = [];
  const worldPoints = [];
  picked.forEach((worldPoint, index) => {
    if (!worldPoint) return;
    imagePoints.push(selectedQueryPoints[index]);
    worldPoints.push(worldPoint);
  });
  if (imagePoints.length < 8)
    return {
      accepted: false,
      rejectionReasons: ["too-few-depth-backed-overlay-points"],
      metrics: { matches: imagePoints.length },
    };
  const requestPath = path.join(directory, "solve-pose-request.json");
  const absoluteRequest = {
    imageSize: {
      width: queryMetadata.width,
      height: queryMetadata.height,
    },
    horizontalFovDeg: seed.horizontalFovDeg,
    prior: {
      ...seed.corrected,
      horizontalAccuracyM: seed.horizontalAccuracyM ?? 10,
      coarse: false,
    },
    imagePoints,
    worldPoints,
  };
  await writeFile(requestPath, `${JSON.stringify(absoluteRequest, null, 2)}\n`);
  let absoluteError;
  try {
    const { stdout } = await run(venvPython, [
      path.join(root, "scripts/photography/calibration/solve_pose.py"),
      requestPath,
    ]);
    const solved = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    if (solved.accepted) return solved;
    absoluteError = solved.rejectionReasons?.join(",");
  } catch (error) {
    absoluteError = error instanceof Error ? error.message : String(error);
  }
  const rotationRequestPath = path.join(
    directory,
    "solve-rotation-request.json",
  );
  await writeFile(
    rotationRequestPath,
    `${JSON.stringify(
      {
        querySize: {
          width: queryMetadata.width,
          height: queryMetadata.height,
        },
        referenceSize: viewport,
        queryHorizontalFovDeg: seed.horizontalFovDeg,
        referenceHorizontalFovDeg: seed.horizontalFovDeg,
        referencePose: {
          headingDeg: seed.headingDeg,
          pitchDeg: seed.pitchDeg ?? 0,
          rollDeg: seed.rollDeg ?? 0,
        },
        prior: absoluteRequest.prior,
        minimumInliers: 8,
        queryPoints: imagePoints,
        referencePoints: selectedReferencePoints.filter(
          (_, index) => picked[index],
        ),
      },
      null,
      2,
    )}\n`,
  );
  try {
    const { stdout } = await run(venvPython, [
      path.join(root, "scripts/photography/calibration/solve_rotation.py"),
      rotationRequestPath,
    ]);
    const solved = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    solved.position = seed.corrected;
    solved.frustum = { nearM: seed.nearM, farM: seed.farM };
    if (!solved.accepted && absoluteError)
      solved.rejectionReasons = [
        ...(solved.rejectionReasons ?? []),
        "absolute-overlay-pose-failed",
      ];
    return solved;
  } catch (error) {
    return {
      accepted: false,
      solutionMode: "rejected",
      rejectionReasons: [
        "absolute-overlay-pose-failed",
        "overlay-rotation-failed",
      ],
      error: {
        absolute: absoluteError,
        rotation: error instanceof Error ? error.message : String(error),
      },
      metrics: { matches: imagePoints.length },
    };
  }
}

if (rollbackLastApplication) {
  const backup = JSON.parse(await readFile(rejectionBackupPath, "utf8"));
  await writeFile(
    rejectionsPath,
    `${JSON.stringify(backup.rejections, null, 2)}\n`,
  );
  console.log(JSON.stringify({ restored: backup.rejections.length }));
  process.exit(0);
}

const envText = await readFile(path.join(root, ".env"), "utf8").catch(() => "");
if (!/^PUBLIC_GOOGLE_MAP_TILES_API_KEY=.+$/m.test(envText))
  throw new Error(
    "PUBLIC_GOOGLE_MAP_TILES_API_KEY is required for overlay audit.",
  );
const allSeeds = JSON.parse(await readFile(pilotsPath, "utf8"));
const queryMap = queryMapPath
  ? new Map(Object.entries(JSON.parse(await readFile(queryMapPath, "utf8"))))
  : new Map();
const seeds = allSeeds.filter(
  (seed) =>
    (!selectedCities.size || selectedCities.has(seed.cityId)) &&
    (!selectedIds.size || selectedIds.has(seed.id)),
);
const manifest = JSON.parse(
  await readFile(path.join(root, "src/data/photography-manifest.json"), "utf8"),
);
const server = spawn(
  process.execPath,
  [
    path.join(root, "node_modules/astro/bin/astro.mjs"),
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    new URL(serverUrl).port || "4324",
  ],
  { cwd: root, stdio: "ignore", env: process.env, windowsHide: true },
);
await waitForServer(server);
const { chromium } = await import("@playwright/test");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 960 },
  deviceScaleFactor: 1,
});
const results = [];
try {
  await page.goto(`${serverUrl}/photography/auto-calibration`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () => document.documentElement.dataset.autoCalibrationReady === "true",
    undefined,
    { timeout: 30_000 },
  );
  let activeCity;
  for (const seed of seeds) {
    const image = manifest.find((candidate) => candidate.id === seed.id);
    const largest = image?.variants.at(-1);
    if (!largest) continue;
    const queryPath =
      queryMap.get(seed.id) ??
      path.join(root, "public", largest.src.replace(/^\//, ""));
    const queryMetadata = await sharp(queryPath).metadata();
    const viewport = viewportFor(queryMetadata.width, queryMetadata.height);
    const directory = path.join(workRoot, seed.id);
    const providerPath = path.join(directory, "provider.png");
    await mkdir(directory, { recursive: true });
    try {
      if (activeCity !== seed.cityId) {
        await page.evaluate(
          (cityId) => window.__PHOTO_AUTO_CALIBRATION__.loadCity(cityId),
          seed.cityId,
        );
        activeCity = seed.cityId;
      }
      await renderAuditView(page, {
        position: seed.corrected,
        pose: {
          headingDeg: seed.headingDeg,
          pitchDeg: seed.pitchDeg ?? 0,
          rollDeg: seed.rollDeg ?? 0,
        },
        optics: {
          horizontalFovDeg: seed.horizontalFovDeg,
          verticalFovDeg: seed.verticalFovDeg,
        },
        viewport,
      });
      await page
        .locator("[data-calibration-canvas] canvas")
        .screenshot({ path: providerPath });
      await assertProviderRenderUsable(providerPath);
      const match = await bestOverlayMatch(queryPath, providerPath, directory);
      const candidate = match.candidates[0];
      const metrics = normalizedOverlayResidual({
        queryPoints: candidate?.queryPoints ?? [],
        referencePoints: candidate?.referencePoints ?? [],
        querySize: {
          width: queryMetadata.width,
          height: queryMetadata.height,
        },
        referenceSize: viewport,
      });
      const classification = classifyOverlayResidual(metrics);
      const result = {
        id: seed.id,
        cityId: seed.cityId,
        matcher: match.matcher,
        geometricModel: candidate?.geometricModel,
        rawMatches: candidate?.rawMatches ?? 0,
        geometricInliers: candidate?.geometricInliers ?? 0,
        ...metrics,
        ...classification,
      };
      if (classification.status === "accepted")
        seed.automaticEvidence = {
          ...seed.automaticEvidence,
          overlayAudit: {
            matcher: match.matcher,
            geometricInliers: candidate?.geometricInliers ?? 0,
            imageCoverage: metrics.imageCoverage,
            medianResidual: metrics.medianResidual,
            p90Residual: metrics.p90Residual,
          },
        };
      if (
        repair &&
        classification.status !== "accepted" &&
        candidate?.geometricInliers >= 8
      ) {
        const solved = await solveOverlayPose({
          seed,
          queryMetadata,
          queryPoints: candidate.queryPoints,
          referencePoints: candidate.referencePoints,
          viewport,
          directory,
          page,
        });
        const repairResult = {
          accepted: solved.accepted,
          solutionMode: solved.solutionMode,
          rejectionReasons: solved.rejectionReasons,
          metrics: solved.metrics,
          ...(solved.accepted
            ? {
                position: solved.position,
                pose: solved.pose,
                optics: solved.optics,
                frustum: solved.frustum,
              }
            : {}),
        };
        let repairedMatcher;
        if (solved.accepted) {
          await renderAuditView(page, {
            position: solved.position,
            pose: solved.pose,
            optics: solved.optics,
            viewport,
          });
          await page
            .locator("[data-calibration-canvas] canvas")
            .screenshot({ path: providerPath });
          const repairedMatch = await bestOverlayMatch(
            queryPath,
            providerPath,
            directory,
          );
          repairedMatcher = repairedMatch.matcher;
          const repairedCandidate = repairedMatch.candidates[0];
          const repairedMetrics = normalizedOverlayResidual({
            queryPoints: repairedCandidate?.queryPoints ?? [],
            referencePoints: repairedCandidate?.referencePoints ?? [],
            querySize: {
              width: queryMetadata.width,
              height: queryMetadata.height,
            },
            referenceSize: viewport,
          });
          repairResult.overlay = {
            geometricInliers: repairedCandidate?.geometricInliers ?? 0,
            ...repairedMetrics,
            ...classifyOverlayResidual(repairedMetrics),
          };
          if (repairResult.overlay.status === "accepted")
            repairResult.frustumDepth = await measureProviderFrustum(
              page,
              solved.position,
              viewport,
            );
        }
        result.repair = repairResult;
        if (
          writeRepairs &&
          repairResult.overlay?.status === "accepted" &&
          repairResult.frustumDepth?.accepted
        ) {
          seed.corrected = repairResult.position;
          seed.headingDeg = repairResult.pose.headingDeg;
          seed.pitchDeg = repairResult.pose.pitchDeg;
          seed.rollDeg = repairResult.pose.rollDeg;
          seed.horizontalFovDeg = repairResult.optics.horizontalFovDeg;
          seed.verticalFovDeg = repairResult.optics.verticalFovDeg;
          seed.nearM = repairResult.frustumDepth.frustum.nearM;
          seed.farM = repairResult.frustumDepth.frustum.farM;
          seed.automaticEvidence = {
            ...seed.automaticEvidence,
            matcher: match.matcher,
            matches: repairResult.metrics.matches,
            inliers: repairResult.metrics.inliers,
            inlierRatio: repairResult.metrics.inlierRatio,
            rmsErrorPx: repairResult.metrics.rmsErrorPx,
            imageCoverage: repairResult.metrics.imageCoverage,
            positionDeltaM: repairResult.metrics.positionDeltaM,
            referenceView: "exact-match-camera-provider-overlay",
            solutionMode: repairResult.solutionMode,
            frustumDepth: repairResult.frustumDepth,
            overlayAudit: {
              matcher: repairedMatcher,
              geometricInliers: repairResult.overlay.geometricInliers,
              imageCoverage: repairResult.overlay.imageCoverage,
              medianResidual: repairResult.overlay.medianResidual,
              p90Residual: repairResult.overlay.p90Residual,
            },
          };
          result.repair.written = true;
        }
      }
      const finalizedResult = finalizeOverlayResult(result);
      results.push(finalizedResult);
      console.log(JSON.stringify(finalizedResult));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = {
        id: seed.id,
        cityId: seed.cityId,
        status: "inconclusive",
        reason:
          message === "provider-render-unavailable"
            ? "provider-render-unavailable"
            : "provider-or-matcher-error",
        error: message,
      };
      results.push(result);
      console.log(JSON.stringify(result));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
  server.kill();
}
const summary = {
  generatedAt: new Date().toISOString(),
  provider: "Google Photorealistic 3D Tiles (ephemeral render)",
  total: results.length,
  accepted: results.filter((result) => result.status === "accepted").length,
  rejected: results.filter((result) => result.status === "rejected").length,
  inconclusive: results.filter((result) => result.status === "inconclusive")
    .length,
  results,
};
const providerRunUnavailable = !overlayRunCanMutate(results);
if (
  !providerRunUnavailable &&
  (applyRejections || writeRepairs) &&
  results.some((result) => result.status === "accepted")
)
  await writeFile(pilotsPath, `${JSON.stringify(allSeeds, null, 2)}\n`);
if (!providerRunUnavailable && (applyRejections || writeRepairs)) {
  let rejections = [];
  try {
    rejections = JSON.parse(await readFile(rejectionsPath, "utf8"));
  } catch {}
  await writeFile(
    rejectionBackupPath,
    `${JSON.stringify(
      { generatedAt: new Date().toISOString(), rejections },
      null,
      2,
    )}\n`,
  );
  const rejectionsById = new Map(
    rejections.map((rejection) => [rejection.id, rejection]),
  );
  const seedById = new Map(allSeeds.map((seed) => [seed.id, seed]));
  for (const result of results) {
    const passed = result.status === "accepted";
    if (passed) {
      rejectionsById.delete(result.id);
      continue;
    }
    if (!applyRejections) continue;
    const cameraCandidate =
      cameraCandidateFromOverlayResult(result, seedById.get(result.id)) ??
      rejectionsById.get(result.id)?.cameraCandidate;
    rejectionsById.set(result.id, {
      id: result.id,
      cityId: result.cityId,
      rejectionReasons: [
        `overlay-audit:${result.status}:${result.reason ?? "unproven"}`,
      ],
      ...(cameraCandidate ? { cameraCandidate } : {}),
    });
  }
  await writeFile(
    rejectionsPath,
    `${JSON.stringify([...rejectionsById.values()], null, 2)}\n`,
  );
}
await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (strict && (summary.rejected || summary.inconclusive)) process.exitCode = 1;
