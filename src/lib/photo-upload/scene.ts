import type {
  CitySceneConfig,
  PhotoSceneRecord,
} from "../photography-map/types";
import type { PhotoMetadata } from "./metadata";

export function matchPhotoCity(
  latitude: number,
  longitude: number,
  cities: CitySceneConfig[],
) {
  return cities.find(
    ({ bounds }) =>
      latitude >= bounds.south &&
      latitude <= bounds.north &&
      longitude >= bounds.west &&
      longitude <= bounds.east,
  );
}

export function photoFieldOfView(
  width: number,
  height: number,
  focalLength35Mm?: number,
) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("This photograph has no valid image dimensions.");
  const diagonal = Math.hypot(width, height);
  const focal = focalLength35Mm ?? 28;
  if (!Number.isFinite(focal) || focal <= 0)
    throw new Error("This photograph has an invalid focal length.");
  const sensorDiagonal = Math.hypot(36, 24);
  const optics = {
    horizontalFovDeg:
      (Math.atan((sensorDiagonal * width) / (diagonal * 2 * focal)) * 360) /
      Math.PI,
    verticalFovDeg:
      (Math.atan((sensorDiagonal * height) / (diagonal * 2 * focal)) * 360) /
      Math.PI,
  };
  if (
    Object.values(optics).some(
      (angle) => !Number.isFinite(angle) || angle <= 0 || angle >= 180,
    )
  )
    throw new Error("This photograph has an invalid field of view.");
  return optics;
}

export function createUploadScene(
  metadata: PhotoMetadata,
  image: { url: string; width: number; height: number },
  cities: CitySceneConfig[],
  manual?: { latitude: number; longitude: number; altitudeM?: number },
) {
  const latitude = manual?.latitude ?? metadata.latitude;
  const longitude = manual?.longitude ?? metadata.longitude;
  if (
    latitude === undefined ||
    longitude === undefined ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    throw new Error(
      "Add a valid latitude and longitude to prepare your scene.",
    );
  const matchedCity = matchPhotoCity(latitude, longitude, cities);
  const altitudeM =
    manual?.altitudeM ??
    metadata.altitudeM ??
    matchedCity?.center.altitudeM ??
    50;
  if (!Number.isFinite(altitudeM) || altitudeM < -500 || altitudeM > 20_000)
    throw new Error("Camera height must be between −500 and 20,000 metres.");
  const position = { latitude, longitude, altitudeM };
  const city: CitySceneConfig = matchedCity ?? {
    id: "custom-location",
    name: "Custom location",
    country: "custom",
    region: "custom",
    description: "A local camera draft from your photograph.",
    publicMap: "none",
    center: position,
    bounds: {
      west: Math.max(-180, longitude - 0.01),
      east: Math.min(180, longitude + 0.01),
      south: Math.max(-90, latitude - 0.01),
      north: Math.min(90, latitude + 0.01),
    },
    defaultCamera: { headingDeg: 0, pitchDeg: -35, rangeM: 800 },
    coverage: { photorealistic: "unknown", osmBuildings: "unknown" },
    pilotPhotoIds: [],
    samplePhotoIds: [],
  };
  const trueHeading =
    metadata.headingReference === "T" ? metadata.headingDeg : undefined;
  const optics = photoFieldOfView(
    image.width,
    image.height,
    metadata.focalLength35Mm,
  );
  const photo: PhotoSceneRecord = {
    id: "local-photo",
    cityId: city.id,
    country: city.country,
    region: city.region,
    image: {
      ...image,
      manifestId: "local-photo",
      thumbnailUrl: image.url,
      alt: "Your selected photograph",
    },
    placement: { kind: "exact", position },
    location: {
      original: position,
      altitudeReference: "ellipsoid",
      originalAltitudeReference:
        metadata.altitudeM !== undefined ? "mean-sea-level" : "unknown",
    },
    pose: {
      headingDeg: trueHeading ?? 0,
      pitchDeg: 0,
      rollDeg: 0,
      source: manual ? "manual" : "estimated",
      confidence: 0,
      calibration: "approximate",
    },
    optics: { ...optics, focalLength35Mm: metadata.focalLength35Mm },
    frustum: { nearM: 1, farM: 120 },
    presentation: "standard",
    preferredTier: "photorealistic",
    privacy: { location: "hidden", timestamp: "hidden" },
    highlight: { mode: "off", approved: false },
    capabilities: {
      marker: true,
      frustum: true,
      comparison: true,
      projection: false,
    },
    rejectionReasons: [],
  };
  return {
    city,
    photo,
    matchedCity,
    hasTrueHeading: trueHeading !== undefined,
  };
}
