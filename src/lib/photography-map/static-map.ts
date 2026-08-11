import type { CitySceneConfig, GeoPosition } from "./types";

const TILE_SIZE = 256;
const MAX_MERCATOR_LATITUDE = 85.05112878;
const VIEWPORT_PADDING = 1.12;

export const STATIC_MAP_WIDTH = 640;
export const STATIC_MAP_HEIGHT = 480;

export type StaticMapViewport = {
  center: Pick<GeoPosition, "latitude" | "longitude">;
  zoom: number;
  width: number;
  height: number;
};

function clampLatitude(latitude: number) {
  return Math.min(
    MAX_MERCATOR_LATITUDE,
    Math.max(-MAX_MERCATOR_LATITUDE, latitude),
  );
}

function mercatorPoint(position: Pick<GeoPosition, "latitude" | "longitude">) {
  const latitude = (clampLatitude(position.latitude) * Math.PI) / 180;
  return {
    x: (position.longitude + 180) / 360,
    y:
      (1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2,
  };
}

function latitudeFromMercator(y: number) {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

export function deriveStaticMapViewport(
  bounds: CitySceneConfig["bounds"],
): StaticMapViewport {
  const northwest = mercatorPoint({
    latitude: bounds.north,
    longitude: bounds.west,
  });
  const southeast = mercatorPoint({
    latitude: bounds.south,
    longitude: bounds.east,
  });
  const spanX = Math.max(Number.EPSILON, southeast.x - northwest.x);
  const spanY = Math.max(Number.EPSILON, southeast.y - northwest.y);
  const zoom = Math.max(
    0,
    Math.min(
      20,
      Math.floor(
        Math.min(
          Math.log2(STATIC_MAP_WIDTH / (TILE_SIZE * spanX * VIEWPORT_PADDING)),
          Math.log2(STATIC_MAP_HEIGHT / (TILE_SIZE * spanY * VIEWPORT_PADDING)),
        ),
      ),
    ),
  );
  const centerX = (northwest.x + southeast.x) / 2;
  const centerY = (northwest.y + southeast.y) / 2;

  return {
    center: {
      latitude: latitudeFromMercator(centerY),
      longitude: centerX * 360 - 180,
    },
    zoom,
    width: STATIC_MAP_WIDTH,
    height: STATIC_MAP_HEIGHT,
  };
}

export function projectStaticMapPosition(
  position: Pick<GeoPosition, "latitude" | "longitude">,
  viewport: StaticMapViewport,
) {
  const point = mercatorPoint(position);
  const center = mercatorPoint(viewport.center);
  const worldSize = TILE_SIZE * 2 ** viewport.zoom;
  const x = 50 + ((point.x - center.x) * worldSize * 100) / viewport.width;
  const y = 50 + ((point.y - center.y) * worldSize * 100) / viewport.height;
  return {
    x: Math.min(100, Math.max(0, x)),
    y: Math.min(100, Math.max(0, y)),
  };
}

export function buildStaticMapUrl(city: CitySceneConfig, apiKey?: string) {
  if (city.publicMap !== "google-2d-3d" || !apiKey) return undefined;
  const viewport = deriveStaticMapViewport(city.bounds);
  const query = new URLSearchParams({
    center: `${viewport.center.latitude.toFixed(6)},${viewport.center.longitude.toFixed(6)}`,
    zoom: String(viewport.zoom),
    size: `${STATIC_MAP_WIDTH}x${STATIC_MAP_HEIGHT}`,
    scale: "2",
    maptype: "satellite",
    format: "jpg",
    key: apiKey,
  });
  return `https://maps.googleapis.com/maps/api/staticmap?${query}`;
}
