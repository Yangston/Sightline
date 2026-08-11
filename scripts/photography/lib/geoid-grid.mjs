import { readFile } from "node:fs/promises";

const ASCII_HASH = 35;

function readToken(buffer, start) {
  let index = start;
  while (index < buffer.length) {
    const byte = buffer[index];
    if (byte === ASCII_HASH) {
      while (index < buffer.length && buffer[index] !== 10) index += 1;
    } else if (byte <= 32) index += 1;
    else break;
  }
  const tokenStart = index;
  while (index < buffer.length && buffer[index] > 32) index += 1;
  return {
    token: buffer.toString("ascii", tokenStart, index),
    next: index,
  };
}

export function parseGeoidPgm(buffer) {
  let cursor = 0;
  const magic = readToken(buffer, cursor);
  cursor = magic.next;
  const widthToken = readToken(buffer, cursor);
  cursor = widthToken.next;
  const heightToken = readToken(buffer, cursor);
  cursor = heightToken.next;
  const maxToken = readToken(buffer, cursor);
  cursor = maxToken.next;
  if (magic.token !== "P5") throw new Error("Geoid grid must be binary PGM.");
  const width = Number(widthToken.token);
  const height = Number(heightToken.token);
  const maxValue = Number(maxToken.token);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    maxValue !== 65535
  )
    throw new Error("Unsupported geoid PGM dimensions or sample depth.");
  while (cursor < buffer.length && buffer[cursor] <= 32) cursor += 1;
  const expectedBytes = width * height * 2;
  if (buffer.length - cursor !== expectedBytes)
    throw new Error("Geoid PGM sample data has an unexpected length.");
  const header = buffer.toString("ascii", 0, cursor);
  const offset = Number(header.match(/^# Offset\s+([-+\d.]+)/m)?.[1]);
  const scale = Number(header.match(/^# Scale\s+([-+\d.]+)/m)?.[1]);
  if (!Number.isFinite(offset) || !Number.isFinite(scale))
    throw new Error("Geoid PGM is missing Offset or Scale metadata.");
  return { buffer, dataOffset: cursor, width, height, offset, scale };
}

export async function readGeoidPgm(filename) {
  return parseGeoidPgm(await readFile(filename));
}

function sample(grid, x, y) {
  const wrappedX = ((x % grid.width) + grid.width) % grid.width;
  const clampedY = Math.max(0, Math.min(grid.height - 1, y));
  const index = grid.dataOffset + (clampedY * grid.width + wrappedX) * 2;
  return grid.offset + grid.scale * grid.buffer.readUInt16BE(index);
}

export function geoidUndulationM(grid, latitude, longitude) {
  if (latitude < -90 || latitude > 90 || !Number.isFinite(longitude))
    throw new Error("Latitude or longitude is outside its valid range.");
  const normalizedLongitude = ((longitude % 360) + 360) % 360;
  const x = (normalizedLongitude / 360) * grid.width;
  const y = ((90 - latitude) / 180) * (grid.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const xFraction = x - x0;
  const yFraction = y - y0;
  const top =
    sample(grid, x0, y0) * (1 - xFraction) +
    sample(grid, x0 + 1, y0) * xFraction;
  const bottom =
    sample(grid, x0, y0 + 1) * (1 - xFraction) +
    sample(grid, x0 + 1, y0 + 1) * xFraction;
  return top * (1 - yFraction) + bottom * yFraction;
}
