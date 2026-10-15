import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import { photographyPoseExperimentById } from "./lib/photography-config.mjs";
import {
  createCoordinateLattice,
  sealPrediction,
  suppressSpatialNearTies,
} from "./lib/image-only-geometry.mjs";
import { createStructuredRunLogger } from "./lib/structured-run-log.mjs";
import { redactRunValue } from "./lib/structured-run-log.mjs";
import { sanitizeImageOnlyPixels } from "./lib/image-only-pixels.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const valueFor = (name) =>
  args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const experimentId = valueFor("--experiment") ?? "sf-north-v1";
const ids = valueFor("--ids")?.split(",").filter(Boolean) ?? [];
const replace = args.includes("--replace");
const serverUrl = valueFor("--server-url");
const resolvedServerUrl =
  serverUrl ?? `http://127.0.0.1:${45_000 + (process.pid % 10_000)}`;
const knownArguments = new Set([
  "--replace",
  args.find((value) => value.startsWith("--experiment=")),
  args.find((value) => value.startsWith("--ids=")),
  args.find((value) => value.startsWith("--server-url=")),
]);
const unknown = args.filter((argument) => !knownArguments.has(argument));
if (unknown.length)
  throw new Error(`Unsupported image-only option: ${unknown.join(", ")}`);

const experiment = photographyPoseExperimentById.get(experimentId);
if (!experiment)
  throw new Error(`Unknown photography pose experiment: ${experimentId}`);
const cohort = new Set(experiment.cohortPhotoIds);
const targets = [...new Set(ids.length ? ids : experiment.cohortPhotoIds)];
const logger = await createStructuredRunLogger({ root, experimentId });
const manifestPath = path.join(root, "src/data/photography-manifest.json");
const publicationPath = path.join(
  root,
  "src/config/photography-publication.json",
);
const pilotsPath = path.join(
  root,
  "src/data/photography-image-only-pilots.json",
);
const rejectionsPath = path.join(
  root,
  "src/data/photography-image-only-rejections.json",
);
const evaluationsPath = path.join(
  root,
  "src/data/photography-image-only-evaluations.json",
);
const baselineMapPath = path.join(
  root,
  "src/data/photography-map-records.json",
);
const archiveRoot = path.join(root, "src/content/photography/iCloud Photos");
const python = path.join(
  root,
  ".venv-photo-calibration",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const pipelineVersion = "sf-north-v1.0.0";

async function readJson(filename, fallback = []) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      env: {
        ...process.env,
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(
          `Private worker failed with exit code ${code}; inspect the run timeline.`,
        );
        error.privateOutput = `${stdout}\n${stderr}`;
        reject(error);
      }
    });
  });
}

async function runPythonJson(script, request, directory) {
  const requestPath = path.join(
    directory,
    `${path.basename(script, ".py")}.json`,
  );
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  const { stdout } = await run(python, [
    path.join(root, "scripts/photography/calibration", script),
    requestPath,
  ]);
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}

function zeroEvidence(overrides = {}) {
  return {
    coarseCandidates: 0,
    panoramaCandidates: 0,
    rankedReferences: 0,
    ...overrides,
  };
}

function sealOutcome(outcome) {
  const prediction = { ...outcome };
  delete prediction.sealed;
  return {
    ...outcome,
    sealed: {
      algorithm: "sha256",
      predictionDigest: sealPrediction(prediction),
    },
  };
}

function failureOutcome(prepared, reasons, status = "no-solution", evidence) {
  return sealOutcome({
    id: prepared.id,
    cityId: experiment.cityId,
    experimentId,
    method: "image-only",
    status,
    pixelDigest: prepared.pixelDigest,
    pipelineVersion,
    pixelRotationDeg: prepared.pixelRotationDeg ?? 0,
    rejectionReasons: reasons,
    evidence: evidence ?? prepared.evidence ?? zeroEvidence(),
  });
}

const baselineBefore = createHash("sha256")
  .update(await readFile(baselineMapPath))
  .digest("hex");
const [manifest, publication, existingPilots, existingRejections] =
  await Promise.all([
    readJson(manifestPath),
    readJson(publicationPath, { records: [] }),
    readJson(pilotsPath),
    readJson(rejectionsPath),
  ]);
const manifestById = new Map(manifest.map((item) => [item.id, item]));
const publicationById = new Map(
  publication.records.map((item) => [item.id, item]),
);
const previousOutcomes = new Set([
  ...existingPilots.map((item) => item.id),
  ...existingRejections.map((item) => item.id),
]);
const lattice = createCoordinateLattice(
  experiment.bounds,
  experiment.gridSpacingM,
);
const prepared = [];
const outcomes = [];

try {
  for (const id of targets) {
    await logger.event("intake", { photoId: id, status: "started" });
    if (!cohort.has(id)) {
      await logger.event("intake", {
        photoId: id,
        status: "outside-pilot-area",
      });
      continue;
    }
    if (!replace && previousOutcomes.has(id)) {
      await logger.event("intake", { photoId: id, status: "already-sealed" });
      continue;
    }
    const image = manifestById.get(id);
    if (!image || publicationById.get(id)?.location !== "exact")
      throw new Error(
        `${id}: cohort membership requires exact publication approval.`,
      );
    const directory = path.join(logger.directory, id);
    await mkdir(directory, { recursive: true });
    const pixelPath = path.join(directory, "pixels.png");
    const sourcePath = path.join(archiveRoot, image.source);
    const sanitized = await sanitizeImageOnlyPixels(sourcePath, pixelPath);
    const { pixelDigest } = sanitized;
    await logger.event("pixel-sanitization", {
      photoId: id,
      status: "metadata-stripped",
      pixelDigest,
      width: sanitized.width,
      height: sanitized.height,
    });
    const rotatedOutputPath = path.join(directory, "query-rotated.png");
    let search;
    try {
      search = await runPythonJson(
        "image_only_search.py",
        { pixelPath, rotatedOutputPath, coordinates: lattice },
        directory,
      );
    } catch {
      const item = {
        id,
        pixelDigest,
        pixelRotationDeg: 0,
        pixelWidth: sanitized.width,
        pixelHeight: sanitized.height,
      };
      await logger.event("geoclip-search", {
        photoId: id,
        status: "rejected",
        reason: "geoclip-model-unavailable",
      });
      for (const stage of [
        "panorama-discovery",
        "reference-rendering",
        "clip-ranking",
        "lightglue",
        "depth-picks",
        "pnp-fov-solving",
        "frustum-checks",
        "overlay-audit",
      ])
        await logger.event(stage, { photoId: id, status: "skipped" });
      const outcome = failureOutcome(item, ["geoclip-model-unavailable"]);
      outcomes.push({
        ...outcome,
        pixelWidth: sanitized.width,
        pixelHeight: sanitized.height,
      });
      await logger.event("sealing", {
        photoId: id,
        status: outcome.status,
        predictionDigest: outcome.sealed.predictionDigest,
      });
      continue;
    }
    const candidates = suppressSpatialNearTies(search.scoredCoordinates, {
      primaryLimit: experiment.candidateLimit,
      fallbackLimit: experiment.fallbackCandidateLimit,
      suppressionRadiusM: experiment.suppressionRadiusM,
    });
    const rotatedInfo = await sharp(rotatedOutputPath).metadata();
    const item = {
      id,
      pixelDigest,
      pixelRotationDeg: search.pixelRotationDeg,
      pixelWidth: rotatedInfo.width,
      pixelHeight: rotatedInfo.height,
      queryPath: rotatedOutputPath,
      searchPriors: candidates,
      evidence: zeroEvidence({
        coarseCandidates:
          candidates.primary.length + candidates.fallback.length,
      }),
    };
    prepared.push(item);
    await logger.event("geoclip-search", {
      photoId: id,
      status: "complete",
      model: search.model,
      rotationDeg: search.pixelRotationDeg,
      primaryCandidates: candidates.primary.length,
      fallbackCandidates: candidates.fallback.length,
    });
    await logger.event("panorama-discovery", {
      photoId: id,
      status: "started",
    });
  }

  let workerById = new Map();
  if (prepared.length) {
    const shardCount = Math.min(2, prepared.length);
    const shards = Array.from({ length: shardCount }, () => []);
    prepared.forEach((item, index) => shards[index % shardCount].push(item));
    const shardResults = await Promise.all(
      shards.map(async (records, shardIndex) => {
        const suffix = shardCount === 1 ? "" : `-${shardIndex + 1}`;
        const workerRequestPath = path.join(
          logger.directory,
          `worker-request${suffix}.json`,
        );
        const workerResultPath = path.join(
          logger.directory,
          `worker-result${suffix}.json`,
        );
        const shardServerUrl = serverUrl
          ? resolvedServerUrl
          : `http://127.0.0.1:${Number(new URL(resolvedServerUrl).port) + shardIndex}`;
        await writeFile(
          workerRequestPath,
          `${JSON.stringify(
            {
              experimentId,
              cityId: experiment.cityId,
              country: experiment.country,
              workRoot: path.join(logger.directory, `worker${suffix}`),
              resultPath: workerResultPath,
              records: records.map((item) => ({
                id: item.id,
                imageOnly: true,
                experimentId,
                cityId: experiment.cityId,
                queryPath: item.queryPath,
                pixelDigest: item.pixelDigest,
                pixelRotationDeg: item.pixelRotationDeg,
                searchPriors: item.searchPriors,
                bounds: experiment.bounds,
                panoramaRadiusM: experiment.panoramaRadiusM,
                maximumPanoramaDistanceM: experiment.maximumPanoramaDistanceM,
              })),
            },
            null,
            2,
          )}\n`,
        );
        try {
          await run(process.execPath, [
            path.join(root, "scripts/photography/calibrate-map.mjs"),
            `--image-only-request=${workerRequestPath}`,
            `--server-url=${shardServerUrl}`,
            ...(serverUrl ? [] : ["--spawn-server"]),
          ]);
          return await readJson(workerResultPath);
        } catch (error) {
          await writeFile(
            path.join(logger.directory, `worker-failure${suffix}.json`),
            `${JSON.stringify(
              redactRunValue({
                error: error instanceof Error ? error.message : String(error),
                output: error?.privateOutput,
              }),
              null,
              2,
            )}\n`,
          );
          return [];
        }
      }),
    );
    workerById = new Map(shardResults.flat().map((item) => [item.id, item]));
  }

  const provisionalAccepted = [];
  for (const item of prepared) {
    const result = workerById.get(item.id);
    const solved = result?.solved;
    const evidence = zeroEvidence({
      coarseCandidates: item.evidence.coarseCandidates,
      panoramaCandidates: result ? 1 : 0,
      rankedReferences: result?.rankedReferenceViews ?? 0,
      matches: solved?.metrics?.matches,
      inliers: solved?.metrics?.inliers,
      inlierRatio: solved?.metrics?.inlierRatio,
      rmsErrorPx: solved?.metrics?.rmsErrorPx ?? null,
      imageCoverage: solved?.metrics?.imageCoverage,
      referenceDistanceM: solved?.metrics?.positionDeltaM,
      solutionMode:
        solved?.solutionMode === "absolute-pose" ? "absolute-pose" : undefined,
    });
    await logger.event("panorama-discovery", {
      photoId: item.id,
      status: result ? "complete" : "rejected",
    });
    await logger.event("reference-rendering", {
      photoId: item.id,
      status: result ? "complete" : "skipped",
    });
    await logger.event("clip-ranking", {
      photoId: item.id,
      status: result ? "complete" : "skipped",
      references: result?.rankedReferenceViews ?? 0,
    });
    await logger.event("lightglue", {
      photoId: item.id,
      status: result?.matcher?.startsWith("lightglue")
        ? "complete"
        : "rejected",
      matcher: result?.matcher ?? "unavailable",
    });
    await logger.event("depth-picks", {
      photoId: item.id,
      status: solved?.metrics?.matches ? "complete" : "rejected",
      matches: solved?.metrics?.matches ?? 0,
    });
    await logger.event("pnp-fov-solving", {
      photoId: item.id,
      status: solved?.accepted ? "accepted" : "rejected",
      solutionMode: solved?.solutionMode,
    });
    await logger.event("frustum-checks", {
      photoId: item.id,
      status: solved?.frustumDepthEvidence?.accepted ? "accepted" : "rejected",
    });
    if (
      solved?.accepted &&
      solved.solutionMode === "absolute-pose" &&
      solved.frustumDepthEvidence?.accepted
    )
      provisionalAccepted.push({ item, result, solved, evidence });
    else {
      await logger.event("overlay-audit", {
        photoId: item.id,
        status: "skipped",
      });
      const reasons = solved?.rejectionReasons?.length
        ? solved.rejectionReasons
        : ["image-only-geometric-solution-unavailable"];
      const outcome = failureOutcome(
        item,
        reasons,
        result ? "rejected" : "no-solution",
        evidence,
      );
      outcomes.push({
        ...outcome,
        pixelWidth: item.pixelWidth,
        pixelHeight: item.pixelHeight,
      });
      await logger.event("sealing", {
        photoId: item.id,
        status: outcome.status,
        predictionDigest: outcome.sealed.predictionDigest,
      });
    }
  }

  let overlayById = new Map();
  if (provisionalAccepted.length) {
    const overlaySeedsPath = path.join(logger.directory, "overlay-seeds.json");
    const queryMapPath = path.join(logger.directory, "overlay-queries.json");
    const overlayReportPath = path.join(
      logger.directory,
      "overlay-report.json",
    );
    await writeFile(
      overlaySeedsPath,
      `${JSON.stringify(
        provisionalAccepted.map(({ item, solved }) => ({
          id: item.id,
          cityId: experiment.cityId,
          corrected: solved.position,
          headingDeg: solved.pose.headingDeg,
          pitchDeg: solved.pose.pitchDeg,
          rollDeg: solved.pose.rollDeg,
          horizontalFovDeg: solved.optics.horizontalFovDeg,
          verticalFovDeg: solved.optics.verticalFovDeg,
          nearM: solved.frustum.nearM,
          farM: solved.frustum.farM,
          automaticEvidence: {},
        })),
        null,
        2,
      )}\n`,
    );
    await writeFile(
      queryMapPath,
      `${JSON.stringify(
        Object.fromEntries(
          provisionalAccepted.map(({ item }) => [item.id, item.queryPath]),
        ),
        null,
        2,
      )}\n`,
    );
    try {
      await run(process.execPath, [
        path.join(root, "scripts/photography/verify-map.mjs"),
        `--pilots-path=${overlaySeedsPath}`,
        `--query-map=${queryMapPath}`,
        `--report-path=${overlayReportPath}`,
        `--work-root=${path.join(logger.directory, "overlay-work")}`,
        `--ids=${provisionalAccepted.map(({ item }) => item.id).join(",")}`,
        `--server-url=${resolvedServerUrl}`,
      ]);
      const report = await readJson(overlayReportPath, { results: [] });
      overlayById = new Map(report.results.map((item) => [item.id, item]));
    } catch {
      overlayById = new Map();
    }
  }

  for (const { item, solved, evidence } of provisionalAccepted) {
    const audit = overlayById.get(item.id);
    await logger.event("overlay-audit", {
      photoId: item.id,
      status: audit?.status ?? "inconclusive",
      geometricInliers: audit?.geometricInliers ?? 0,
    });
    let outcome;
    if (audit?.status === "accepted") {
      outcome = sealOutcome({
        id: item.id,
        cityId: experiment.cityId,
        experimentId,
        method: "image-only",
        status: "accepted",
        pixelDigest: item.pixelDigest,
        pipelineVersion,
        pixelRotationDeg: item.pixelRotationDeg,
        position: solved.position,
        headingDeg: solved.pose.headingDeg,
        pitchDeg: solved.pose.pitchDeg,
        rollDeg: solved.pose.rollDeg,
        horizontalFovDeg: solved.optics.horizontalFovDeg,
        confidence: Math.min(
          0.99,
          0.55 +
            solved.metrics.inlierRatio * 0.25 +
            solved.metrics.imageCoverage * 0.2,
        ),
        nearM: solved.frustum.nearM,
        farM: solved.frustum.farM,
        evidence,
        overlayAudit: {
          matcher: audit.matcher,
          geometricInliers: audit.geometricInliers,
          imageCoverage: audit.imageCoverage,
          medianResidual: audit.medianResidual,
          p90Residual: audit.p90Residual,
        },
      });
    } else
      outcome = failureOutcome(
        item,
        [
          `overlay-audit:${audit?.status ?? "inconclusive"}:${audit?.reason ?? "unproven"}`,
        ],
        "rejected",
        evidence,
      );
    outcomes.push({
      ...outcome,
      pixelWidth: item.pixelWidth,
      pixelHeight: item.pixelHeight,
    });
    await logger.event("sealing", {
      photoId: item.id,
      status: outcome.status,
      predictionDigest: outcome.sealed.predictionDigest,
    });
  }

  const publicOutcomes = outcomes.map((outcome) => {
    const publicOutcome = { ...outcome };
    Reflect.deleteProperty(publicOutcome, "pixelWidth");
    Reflect.deleteProperty(publicOutcome, "pixelHeight");
    return publicOutcome;
  });
  const targetSet = new Set(publicOutcomes.map((item) => item.id));
  const nextPilots = [
    ...existingPilots.filter((item) => !targetSet.has(item.id)),
    ...publicOutcomes.filter((item) => item.status === "accepted"),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const nextRejections = [
    ...existingRejections.filter((item) => !targetSet.has(item.id)),
    ...publicOutcomes.filter((item) => item.status !== "accepted"),
  ].sort((left, right) => left.id.localeCompare(right.id));
  await Promise.all([
    writeFile(pilotsPath, `${JSON.stringify(nextPilots, null, 2)}\n`),
    writeFile(rejectionsPath, `${JSON.stringify(nextRejections, null, 2)}\n`),
  ]);

  const predictionsPath = path.join(
    logger.directory,
    "sealed-predictions.json",
  );
  const evaluationRequestPath = path.join(
    logger.directory,
    "evaluation-request.json",
  );
  const evaluationOutputPath = path.join(logger.directory, "evaluations.json");
  await writeFile(predictionsPath, `${JSON.stringify(outcomes, null, 2)}\n`);
  await writeFile(
    evaluationRequestPath,
    `${JSON.stringify({ predictionsPath, outputPath: evaluationOutputPath }, null, 2)}\n`,
  );
  await run(process.execPath, [
    path.join(root, "scripts/photography/evaluate-image-only.mjs"),
    evaluationRequestPath,
  ]);
  const newEvaluations = await readJson(evaluationOutputPath);
  const existingEvaluations = await readJson(evaluationsPath);
  const evaluationIds = new Set(newEvaluations.map((item) => item.id));
  await writeFile(
    evaluationsPath,
    `${JSON.stringify(
      [
        ...existingEvaluations.filter((item) => !evaluationIds.has(item.id)),
        ...newEvaluations,
      ].sort((left, right) => left.id.localeCompare(right.id)),
      null,
      2,
    )}\n`,
  );
  for (const outcome of outcomes)
    await logger.event("metadata-evaluation", {
      photoId: outcome.id,
      status: "post-seal-complete",
    });

  const baselineAfter = createHash("sha256")
    .update(await readFile(baselineMapPath))
    .digest("hex");
  if (baselineAfter !== baselineBefore)
    throw new Error(
      "The image-only experiment changed baseline map membership.",
    );
  for (const outcome of outcomes)
    await logger.event("publication-refresh", {
      photoId: outcome.id,
      status: "parallel-records-written",
      baselineMapUnchanged: true,
    });
  const report = await logger.finish({
    status: "complete",
    targets: targets.length,
    processed: outcomes.length,
    accepted: outcomes.filter((item) => item.status === "accepted").length,
    rejected: outcomes.filter((item) => item.status === "rejected").length,
    noSolution: outcomes.filter((item) => item.status === "no-solution").length,
  });
  console.log(`Image-only run ${report.runId}`);
  console.log(`Timeline report: ${report.reportPath}`);
} catch (error) {
  const report = await logger.finish({
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  });
  console.error(`Image-only run ${report.runId} failed.`);
  console.error(`Timeline report: ${report.reportPath}`);
  throw error;
} finally {
  for (const item of prepared) {
    await rm(item.queryPath, { force: true }).catch(() => {});
    await rm(path.join(logger.directory, item.id, "pixels.png"), {
      force: true,
    }).catch(() => {});
  }
}
