/** Only the fields needed for a camera draft are read. Files never leave the browser. */
export type PhotoMetadata = {
  latitude?: number;
  longitude?: number;
  altitudeM?: number;
  headingDeg?: number;
  headingReference?: string;
  focalLength35Mm?: number;
  orientation?: number;
};

const fieldSizes: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  7: 1,
  9: 4,
  10: 8,
};

function ascii(bytes: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function exifBlock(bytes: Uint8Array): Uint8Array | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let cursor = 2;
    while (cursor + 4 <= bytes.length) {
      if (bytes[cursor] !== 0xff) break;
      const marker = bytes[cursor + 1];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0xff) {
        cursor += 1;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        cursor += 2;
        continue;
      }
      const size = view.getUint16(cursor + 2);
      if (size < 2 || cursor + 2 + size > bytes.length) break;
      if (marker === 0xe1 && ascii(bytes, cursor + 4, 6) === "Exif\0\0")
        return bytes.subarray(cursor + 10, cursor + 2 + size);
      cursor += 2 + size;
    }
  }
  if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") {
    let cursor = 8;
    while (cursor + 12 <= bytes.length) {
      const size = view.getUint32(cursor);
      if (cursor + size + 12 > bytes.length) break;
      if (ascii(bytes, cursor + 4, 4) === "eXIf")
        return bytes.subarray(cursor + 8, cursor + 8 + size);
      cursor += size + 12;
    }
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    let cursor = 12;
    while (cursor + 8 <= bytes.length) {
      const size = view.getUint32(cursor + 4, true);
      if (cursor + size + 8 > bytes.length) break;
      if (ascii(bytes, cursor, 4) === "EXIF") {
        const start = ascii(bytes, cursor + 8, 6) === "Exif\0\0" ? 14 : 8;
        return bytes.subarray(cursor + start, cursor + 8 + size);
      }
      cursor += size + 8 + (size % 2);
    }
  }
  return undefined;
}

export function readPhotoMetadata(buffer: ArrayBuffer): PhotoMetadata {
  const bytes = exifBlock(new Uint8Array(buffer));
  if (!bytes || bytes.length < 8) return {};
  const byteOrder = ascii(bytes, 0, 2);
  if (byteOrder !== "II" && byteOrder !== "MM") return {};
  const little = byteOrder === "II";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) return {};
  const directory = (offset: number) => {
    const fields = new Map<number, number[] | string>();
    if (!Number.isInteger(offset) || offset < 8 || offset + 2 > bytes.length)
      return fields;
    const entries = view.getUint16(offset, little);
    if (entries > 512 || offset + 2 + entries * 12 > bytes.length)
      return fields;
    for (let index = 0; index < entries; index += 1) {
      const entry = offset + 2 + index * 12;
      const tag = view.getUint16(entry, little);
      const type = view.getUint16(entry + 2, little);
      const count = view.getUint32(entry + 4, little);
      const unit = fieldSizes[type];
      if (!unit || count < 1 || count > 64) continue;
      const size = unit * count;
      const start = size <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
      if (start + size > bytes.length) continue;
      if (type === 2) {
        fields.set(tag, ascii(bytes, start, count).replace(/\0.*$/, "").trim());
        continue;
      }
      const values: number[] = [];
      for (let item = 0; item < count; item += 1) {
        const at = start + item * unit;
        if (type === 5 || type === 10) {
          const numerator =
            type === 5 ? view.getUint32(at, little) : view.getInt32(at, little);
          const denominator =
            type === 5
              ? view.getUint32(at + 4, little)
              : view.getInt32(at + 4, little);
          values.push(denominator ? numerator / denominator : NaN);
        } else if (type === 3) values.push(view.getUint16(at, little));
        else if (type === 4) values.push(view.getUint32(at, little));
        else if (type === 9) values.push(view.getInt32(at, little));
        else values.push(view.getUint8(at));
      }
      fields.set(tag, values);
    }
    return fields;
  };
  const number = (fields: Map<number, number[] | string>, tag: number) => {
    const value = fields.get(tag);
    return Array.isArray(value) && Number.isFinite(value[0])
      ? value[0]
      : undefined;
  };
  const main = directory(view.getUint32(4, little));
  const exif = directory(number(main, 0x8769) ?? 0);
  const gps = directory(number(main, 0x8825) ?? 0);
  const coordinate = (
    tag: number,
    positive: string,
    negative: string,
    limit: number,
  ) => {
    const values = gps.get(tag);
    const reference = gps.get(tag - 1);
    if (
      !Array.isArray(values) ||
      values.length !== 3 ||
      !values.every(Number.isFinite) ||
      (reference !== positive && reference !== negative) ||
      values[0] < 0 ||
      values[1] < 0 ||
      values[1] >= 60 ||
      values[2] < 0 ||
      values[2] >= 60
    )
      return undefined;
    const decimal = values[0] + values[1] / 60 + values[2] / 3600;
    return decimal <= limit
      ? decimal * (reference === negative ? -1 : 1)
      : undefined;
  };
  const latitude = coordinate(2, "N", "S", 90);
  const longitude = coordinate(4, "E", "W", 180);
  const altitude = number(gps, 6);
  const heading = number(gps, 17);
  const focal = number(exif, 0xa405);
  return {
    ...(latitude !== undefined && longitude !== undefined
      ? { latitude, longitude }
      : {}),
    ...(altitude !== undefined && altitude < 100_000
      ? { altitudeM: altitude * (number(gps, 5) === 1 ? -1 : 1) }
      : {}),
    ...(heading !== undefined && heading >= 0 && heading <= 360
      ? {
          headingDeg: heading % 360,
          headingReference: String(gps.get(16) ?? ""),
        }
      : {}),
    ...(focal !== undefined && focal >= 1 && focal <= 2_000
      ? { focalLength35Mm: focal }
      : {}),
    orientation: number(main, 0x0112),
  };
}
