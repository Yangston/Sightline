import manifestJson from "@/data/photography-manifest.json";
import { cityScenes, getPilotPhotosForCity } from "@/lib/photography-map";

export type DatasetImage = (typeof manifestJson)[number];

export const datasetImages = manifestJson;

export function imagesForCity(cityId: string) {
  const ids = new Set(getPilotPhotosForCity(cityId).map((photo) => photo.id));
  return datasetImages.filter((image) => ids.has(image.id));
}

export function cityDatasetSummaries() {
  return cityScenes.map((city) => {
    const images = imagesForCity(city.id);
    const sample =
      images.find((image) => city.samplePhotoIds.includes(image.id)) ??
      images[0];
    return { city, images, sample };
  });
}
