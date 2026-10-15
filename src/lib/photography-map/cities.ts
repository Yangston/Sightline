import photographyConfigJson from "@/config/photography.json";
import mapRecordsJson from "@/data/photography-map-records.json";
import type { CitySceneConfig } from "./types";

type MapMembership = {
  id: string;
  sceneId: string;
  country: string;
  region: string;
};

type RegionConfig = {
  key: string;
  country: string;
  archiveCountry: string;
  id: string;
};

const regions = new Map(
  (photographyConfigJson.regions as RegionConfig[]).map((region) => [
    region.key,
    region,
  ]),
);
const mapRecords = mapRecordsJson as MapMembership[];

export const cityScenes: CitySceneConfig[] = photographyConfigJson.cities.map(
  (city) => {
    const region = regions.get(city.regionKey);
    if (!region)
      throw new Error(
        `Photography city ${city.id} references unknown region ${city.regionKey}.`,
      );
    const sampleIds = new Set(city.samplePhotoIds);
    if (sampleIds.size !== city.samplePhotoIds.length)
      throw new Error(`Photography city ${city.id} has duplicate sample IDs.`);
    if (sampleIds.size < 1 || sampleIds.size > 2)
      throw new Error(
        `Photography city ${city.id} requires one or two sample photos.`,
      );
    for (const id of sampleIds) {
      const sample = mapRecords.find((photo) => photo.id === id);
      if (
        !sample ||
        sample.sceneId !== city.id ||
        sample.country !== region.country ||
        sample.region !== region.id
      )
        throw new Error(
          `Photography sample ${id} does not belong to city ${city.id}.`,
        );
    }
    for (const experiment of city.poseExperiments ?? []) {
      if (experiment.method !== "image-only")
        throw new Error(
          `Photography experiment ${experiment.id} has an unsupported method.`,
        );
      const cohort = new Set(experiment.cohortPhotoIds);
      if (cohort.size !== experiment.cohortPhotoIds.length)
        throw new Error(
          `Photography experiment ${experiment.id} has duplicate cohort IDs.`,
        );
      if (
        experiment.bounds.west < city.bounds.west ||
        experiment.bounds.south < city.bounds.south ||
        experiment.bounds.east > city.bounds.east ||
        experiment.bounds.north > city.bounds.north
      )
        throw new Error(
          `Photography experiment ${experiment.id} extends beyond its city bounds.`,
        );
      for (const id of cohort) {
        const photo = mapRecords.find((record) => record.id === id);
        if (!photo || photo.sceneId !== city.id)
          throw new Error(
            `Photography experiment ${experiment.id} includes non-city photo ${id}.`,
          );
      }
    }
    return {
      ...city,
      country: region.country,
      region: region.id,
      publicMap: city.publicMap as CitySceneConfig["publicMap"],
      coverage: city.coverage as CitySceneConfig["coverage"],
      poseExperiments: city.poseExperiments as
        CitySceneConfig["poseExperiments"] | undefined,
      pilotPhotoIds: mapRecords
        .filter((photo) => photo.sceneId === city.id)
        .map((photo) => photo.id),
    };
  },
);

export function getCitiesForCountry(country: string) {
  return cityScenes.filter((city) => city.country === country);
}

export function getCityForCountry(country: string, cityId: string) {
  return cityScenes.find(
    (city) => city.country === country && city.id === cityId,
  );
}
