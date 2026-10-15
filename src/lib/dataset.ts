import manifestJson from "@/data/photography-manifest.json";
import { cityScenes, getPilotPhotosForCity } from "@/lib/photography-map";
import { getStartingPhoto } from "@/lib/collection";

export type DatasetImage = (typeof manifestJson)[number];

export const datasetImages = manifestJson;

export function imagesForCity(cityId: string) {
  const ids = new Set(getPilotPhotosForCity(cityId).map((photo) => photo.id));
  const images = datasetImages.filter((image) => ids.has(image.id));
  const startingPhoto = getStartingPhoto(cityId, images);
  return startingPhoto
    ? [
        startingPhoto,
        ...images.filter((image) => image.id !== startingPhoto.id),
      ]
    : images;
}

export function cityDatasetSummaries() {
  return cityScenes.map((city) => {
    const images = imagesForCity(city.id);
    const sample = getStartingPhoto(city.id, images);
    return { city, images, sample };
  });
}
