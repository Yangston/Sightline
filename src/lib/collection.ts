export const collectionCityIds = ["san-francisco", "toronto"] as const;

export function isCollectionCity(cityId: string) {
  return collectionCityIds.some((id) => id === cityId);
}

export const defaultPhotoIds: Readonly<Record<string, string>> = {
  "san-francisco": "img-7561",
  toronto: "img-7449",
};

export function getStartingPhoto<T extends { id: string }>(
  cityId: string,
  photos: readonly T[],
): T | undefined {
  return (
    photos.find((photo) => photo.id === defaultPhotoIds[cityId]) ?? photos[0]
  );
}
