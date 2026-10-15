import type {
  CitySceneConfig,
  GeoPosition,
  PhotoReviewCategory,
  PhotoSceneRecord,
  PublicMapPhotoSummary,
} from "./types";

type MarkerPhoto = PhotoSceneRecord | PublicMapPhotoSummary;

export type PhotoMarkerGroup = {
  id: string;
  position: GeoPosition;
  placementKind: PhotoSceneRecord["placement"]["kind"];
  photos: MarkerPhoto[];
};

export function photoReviewCategory(photo: {
  pose: Pick<PhotoSceneRecord["pose"], "calibration">;
}): PhotoReviewCategory {
  if (photo.pose.calibration === "calibrated") return "complete";
  if (photo.pose.calibration === "rejected") return "failed-tests";
  return "missing-data";
}

export function photoReviewLabel(category: PhotoReviewCategory) {
  if (category === "failed-tests") return "Rejected candidates";
  if (category === "missing-data") return "Missing data";
  return "Solved poses";
}

export function groupPhotoMarkers(photos: MarkerPhoto[]) {
  const groups = new Map<string, PhotoMarkerGroup>();
  for (const photo of photos) {
    if (photo.placement.kind === "hidden" || !photo.capabilities.marker)
      continue;
    const position = photo.placement.position;
    const precision = photo.placement.kind === "exact" ? 5 : 4;
    const key = [
      photo.placement.kind,
      position.latitude.toFixed(precision),
      position.longitude.toFixed(precision),
    ].join(":");
    const current = groups.get(key);
    if (current) current.photos.push(photo);
    else
      groups.set(key, {
        id: key,
        position,
        placementKind: photo.placement.kind,
        photos: [photo],
      });
  }
  return [...groups.values()];
}

export function projectCityPosition(
  position: Pick<GeoPosition, "latitude" | "longitude">,
  bounds: CitySceneConfig["bounds"],
) {
  const longitudeSpan = Math.max(Number.EPSILON, bounds.east - bounds.west);
  const latitudeSpan = Math.max(Number.EPSILON, bounds.north - bounds.south);
  return {
    x: Math.min(
      100,
      Math.max(0, ((position.longitude - bounds.west) / longitudeSpan) * 100),
    ),
    y: Math.min(
      100,
      Math.max(0, ((bounds.north - position.latitude) / latitudeSpan) * 100),
    ),
  };
}

export function countPhotoReviewCategories(photos: PhotoSceneRecord[]) {
  return photos.reduce<Record<PhotoReviewCategory, number>>(
    (counts, photo) => {
      counts[photoReviewCategory(photo)] += 1;
      return counts;
    },
    { complete: 0, "failed-tests": 0, "missing-data": 0 },
  );
}
