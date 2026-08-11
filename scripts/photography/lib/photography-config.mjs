import { readFileSync } from "node:fs";

const configPath = new URL(
  "../../../src/config/photography.json",
  import.meta.url,
);
const config = JSON.parse(readFileSync(configPath, "utf8"));

if (!Array.isArray(config.regions) || !Array.isArray(config.cities))
  throw new Error(
    "Photography configuration requires regions and cities arrays.",
  );

export const photographyRegions = config.regions;
export const photographyRegionByKey = new Map();
export const photographyRegionByArchivePath = new Map();
const regionCoverage = new Set([
  "expected-photorealistic",
  "fallback-only",
  "unknown",
]);

for (const region of photographyRegions) {
  if (
    !region.key ||
    !region.country ||
    !region.archiveCountry ||
    !region.id ||
    !region.name ||
    !region.mapAnchor ||
    !Number.isFinite(region.mapAnchor.latitude) ||
    !Number.isFinite(region.mapAnchor.longitude) ||
    region.mapAnchor.latitude < -90 ||
    region.mapAnchor.latitude > 90 ||
    region.mapAnchor.longitude < -180 ||
    region.mapAnchor.longitude > 180 ||
    !regionCoverage.has(region.coverage)
  )
    throw new Error(
      `Invalid photography region configuration: ${JSON.stringify(region)}`,
    );
  if (photographyRegionByKey.has(region.key))
    throw new Error(`Duplicate photography region key: ${region.key}`);
  if (region.key !== `${region.country}/${region.id}`)
    throw new Error(
      `Photography region key must match its public country and ID: ${region.key}`,
    );
  const archivePath = `${region.archiveCountry}/${region.id}`;
  if (photographyRegionByArchivePath.has(archivePath))
    throw new Error(`Duplicate photography archive path: ${archivePath}`);
  photographyRegionByKey.set(region.key, region);
  photographyRegionByArchivePath.set(archivePath, region);
}

const cityIds = new Set();
export const photographyPoseExperiments = [];
export const photographyCities = config.cities.map((city) => {
  const region = photographyRegionByKey.get(city.regionKey);
  if (!region)
    throw new Error(
      `Photography city ${city.id} references unknown region ${city.regionKey}.`,
    );
  if (!city.id || !city.name || !city.description)
    throw new Error(`Invalid photography city: ${JSON.stringify(city)}`);
  if (cityIds.has(city.id))
    throw new Error(`Duplicate photography city ID: ${city.id}`);
  cityIds.add(city.id);
  if (
    !city.bounds ||
    city.bounds.west > city.bounds.east ||
    city.bounds.south > city.bounds.north
  )
    throw new Error(`Photography city ${city.id} has invalid bounds.`);
  if (
    !city.center ||
    !city.defaultCamera ||
    !["google-2d-3d", "none"].includes(city.publicMap) ||
    !city.coverage ||
    !["expected", "unsupported", "unknown"].includes(
      city.coverage.photorealistic,
    ) ||
    !["expected", "unsupported", "unknown"].includes(
      city.coverage.osmBuildings,
    ) ||
    !Array.isArray(city.pilotPhotoIds) ||
    new Set(city.pilotPhotoIds).size !== city.pilotPhotoIds.length ||
    !Array.isArray(city.samplePhotoIds) ||
    city.samplePhotoIds.length < 1 ||
    city.samplePhotoIds.length > 2 ||
    new Set(city.samplePhotoIds).size !== city.samplePhotoIds.length
  )
    throw new Error(
      `Photography city ${city.id} has invalid map configuration.`,
    );
  for (const experiment of city.poseExperiments ?? []) {
    const cohort = new Set(experiment.cohortPhotoIds ?? []);
    if (
      experiment.method !== "image-only" ||
      !experiment.id ||
      cohort.size === 0 ||
      cohort.size !== experiment.cohortPhotoIds.length ||
      !experiment.bounds ||
      experiment.bounds.west < city.bounds.west ||
      experiment.bounds.south < city.bounds.south ||
      experiment.bounds.east > city.bounds.east ||
      experiment.bounds.north > city.bounds.north ||
      ![
        experiment.gridSpacingM,
        experiment.candidateLimit,
        experiment.fallbackCandidateLimit,
        experiment.suppressionRadiusM,
        experiment.panoramaRadiusM,
        experiment.maximumPanoramaDistanceM,
      ].every((value) => Number.isFinite(value) && value > 0)
    )
      throw new Error(
        `Photography pose experiment ${experiment.id ?? "unknown"} is invalid.`,
      );
    photographyPoseExperiments.push({
      ...experiment,
      cityId: city.id,
      country: region.country,
      region: region.id,
    });
  }
  return {
    ...city,
    country: region.country,
    archiveCountry: region.archiveCountry,
    region: region.id,
  };
});

export const photographyPoseExperimentById = new Map(
  photographyPoseExperiments.map((experiment) => [experiment.id, experiment]),
);
if (photographyPoseExperimentById.size !== photographyPoseExperiments.length)
  throw new Error("Photography pose experiment IDs must be unique.");

const sceneRegionKeys = new Set(
  photographyCities.map((city) => `${city.country}/${city.region}`),
);
for (const region of photographyRegions)
  if (!sceneRegionKeys.has(region.key))
    throw new Error(`Photography region ${region.key} has no map scene.`);
