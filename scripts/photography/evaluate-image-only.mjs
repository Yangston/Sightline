import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { geoidUndulationM, readGeoidPgm } from "./lib/geoid-grid.mjs";
import {
  circularDifferenceDeg,
  haversineDistanceM,
  sealPrediction,
} from "./lib/image-only-geometry.mjs";

const root = process.cwd();
const requestPath = process.argv[2];
if (!requestPath)
  throw new Error("The post-seal evaluator requires a private request path.");
const request = JSON.parse(await readFile(requestPath, "utf8"));
const predictions = JSON.parse(await readFile(request.predictionsPath, "utf8"));
for (const prediction of predictions) {
  const canonical = { ...prediction };
  delete canonical.sealed;
  delete canonical.pixelWidth;
  delete canonical.pixelHeight;
  if (prediction.sealed?.predictionDigest !== sealPrediction(canonical))
    throw new Error(
      `Refusing to evaluate an unsealed image-only prediction: ${prediction.id}.`,
    );
}
const [metadata, geoid] = await Promise.all([
  readFile(path.join(root, ".private/photography-metadata.json"), "utf8").then(
    JSON.parse,
  ),
  readGeoidPgm(path.join(root, ".private/geoid/egm96-15/geoids/egm96-15.pgm")),
]);
const metadataById = new Map(metadata.map((item) => [item.id, item]));

function metadataHorizontalFov(record, prediction) {
  if (!record.focalLength35Mm) return undefined;
  const width = prediction.pixelWidth;
  const height = prediction.pixelHeight;
  const diagonal = Math.hypot(36, 24);
  const imageDiagonal = Math.hypot(width, height);
  const sensorWidth = (diagonal * width) / imageDiagonal;
  return (
    (2 * Math.atan(sensorWidth / (2 * record.focalLength35Mm)) * 180) / Math.PI
  );
}

const evaluations = predictions.map((prediction) => {
  const reference = metadataById.get(prediction.id);
  const base = {
    id: prediction.id,
    experimentId: prediction.experimentId,
    predictionDigest: prediction.sealed.predictionDigest,
  };
  if (!reference?.gps)
    return { ...base, evaluation: { referenceAvailable: false } };
  if (prediction.status !== "accepted")
    return { ...base, evaluation: { referenceAvailable: true } };
  const referencePosition = {
    latitude: reference.gps.latitude,
    longitude: reference.gps.longitude,
    altitudeM:
      reference.gps.altitudeM +
      geoidUndulationM(geoid, reference.gps.latitude, reference.gps.longitude),
  };
  const referenceFov = metadataHorizontalFov(reference, prediction);
  return {
    ...base,
    evaluation: {
      referenceAvailable: true,
      horizontalErrorM: haversineDistanceM(
        prediction.position,
        referencePosition,
      ),
      altitudeErrorM: Math.abs(
        prediction.position.altitudeM - referencePosition.altitudeM,
      ),
      ...(reference.headingDeg === undefined
        ? {}
        : {
            headingErrorDeg: circularDifferenceDeg(
              prediction.headingDeg,
              reference.headingDeg,
            ),
          }),
      ...(reference.pitchDeg === undefined
        ? {}
        : {
            pitchErrorDeg: Math.abs(prediction.pitchDeg - reference.pitchDeg),
          }),
      ...(reference.rollDeg === undefined
        ? {}
        : {
            rollErrorDeg: circularDifferenceDeg(
              prediction.rollDeg,
              reference.rollDeg,
            ),
          }),
      ...(referenceFov === undefined
        ? {}
        : {
            horizontalFovErrorDeg: Math.abs(
              prediction.horizontalFovDeg - referenceFov,
            ),
          }),
    },
  };
});
await writeFile(
  request.outputPath,
  `${JSON.stringify(evaluations, null, 2)}\n`,
);
console.log(JSON.stringify({ evaluated: evaluations.length }));
