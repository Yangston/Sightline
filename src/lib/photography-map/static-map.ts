import type { CitySceneConfig, GeoPosition } from "./types";

const TILE_SIZE = 256;
const MAX_MERCATOR_LATITUDE = 85.05112878;
const VIEWPORT_PADDING = 1.12;

export const STATIC_MAP_WIDTH = 640;
export const STATIC_MAP_HEIGHT = 360;

export type StaticMapViewport = {
  center: Pick<GeoPosition, "latitude" | "longitude">;
  zoom: number;
  width: number;
  height: number;
};

export type StaticMapTile = {
  id: string;
  url: string;
  left: number;
  top: number;
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

export function buildSatelliteTileGrid(
  viewport: StaticMapViewport,
  session: string,
  apiKey: string,
): StaticMapTile[] {
  const center = mercatorPoint(viewport.center);
  const tileCount = 2 ** viewport.zoom;
  const centerPixelX = center.x * tileCount * TILE_SIZE;
  const centerPixelY = center.y * tileCount * TILE_SIZE;
  const originX = centerPixelX - viewport.width / 2;
  const originY = centerPixelY - viewport.height / 2;
  const firstX = Math.floor(originX / TILE_SIZE);
  const lastX = Math.floor((originX + viewport.width - 1) / TILE_SIZE);
  const firstY = Math.floor(originY / TILE_SIZE);
  const lastY = Math.floor((originY + viewport.height - 1) / TILE_SIZE);
  const tiles: StaticMapTile[] = [];

  for (let y = firstY; y <= lastY; y += 1) {
    if (y < 0 || y >= tileCount) continue;
    for (let x = firstX; x <= lastX; x += 1) {
      const wrappedX = ((x % tileCount) + tileCount) % tileCount;
      const query = new URLSearchParams({ session, key: apiKey });
      tiles.push({
        id: `${viewport.zoom}/${wrappedX}/${y}`,
        url: `https://tile.googleapis.com/v1/2dtiles/${viewport.zoom}/${wrappedX}/${y}?${query}`,
        left: x * TILE_SIZE - originX,
        top: y * TILE_SIZE - originY,
        width: TILE_SIZE,
        height: TILE_SIZE,
      });
    }
  }
  return tiles;
}
