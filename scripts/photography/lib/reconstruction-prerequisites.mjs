import { access } from "node:fs/promises";
import path from "node:path";

export function cityForGps(cities, latitude, longitude) {
  const matches = cities.filter(
    ({ bounds }) =>
      longitude >= bounds.west &&
      longitude <= bounds.east &&
      latitude >= bounds.south &&
      latitude <= bounds.north,
  );
  return matches.sort(
    (left, right) =>
      (left.bounds.east - left.bounds.west) *
        (left.bounds.north - left.bounds.south) -
      (right.bounds.east - right.bounds.west) *
        (right.bounds.north - right.bounds.south),
  )[0];
}

export async function assertPhotographyCalibrationPrerequisites({
  root,
  venvPython,
  modelReadyPath,
  geoidPath,
  astroPath,
  googleKey,
}) {
  await access(venvPython).catch(() => {
    throw new Error(
      "Reconstruction environment is missing. Run `npm run sightline:setup` first.",
    );
  });
  await access(modelReadyPath).catch(() => {
    throw new Error(
      "Reconstruction models have not been verified. Run `npm run sightline:setup` first.",
    );
  });
  await access(geoidPath).catch(() => {
    throw new Error(
      `EGM96 geoid data is missing at ${path.relative(root, geoidPath)}.`,
    );
  });
  await access(astroPath).catch(() => {
    throw new Error("Site dependencies are missing. Run `npm install` first.");
  });
  if (!googleKey)
    throw new Error(
      "PUBLIC_GOOGLE_MAP_TILES_API_KEY is required for exact reconstruction verification.",
    );
}
