import { describe, expect, it } from "vitest";
import { readPhotoMetadata } from "../../src/lib/photo-upload/metadata";
import {
  createUploadScene,
  matchPhotoCity,
  photoFieldOfView,
} from "../../src/lib/photo-upload/scene";
import type { CitySceneConfig } from "../../src/lib/photography-map/types";

function jpegWithExif(little = true) {
  const bytes = new Uint8Array(248);
  bytes.set([0xff, 0xd8, 0xff, 0xe1, 0x00, 0xf2, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  const tiff = new DataView(bytes.buffer, 12, 234);
  tiff.setUint16(0, little ? 0x4949 : 0x4d4d);
  tiff.setUint16(2, 42, little);
  tiff.setUint32(4, 8, little);
  const entry = (
    at: number,
    tag: number,
    type: number,
    count: number,
    value: number,
  ) => {
    tiff.setUint16(at, tag, little);
    tiff.setUint16(at + 2, type, little);
    tiff.setUint32(at + 4, count, little);
    if (type === 2 || type === 1) tiff.setUint8(at + 8, value);
    else if (type === 3) tiff.setUint16(at + 8, value, little);
    else tiff.setUint32(at + 8, value, little);
  };
  tiff.setUint16(8, 3, little);
  entry(10, 0x8825, 4, 1, 50);
  entry(22, 0x8769, 4, 1, 152);
  entry(34, 0x0112, 3, 1, 6);
  tiff.setUint16(50, 8, little);
  entry(52, 1, 2, 2, 78);
  entry(64, 2, 5, 3, 170);
  entry(76, 3, 2, 2, 87);
  entry(88, 4, 5, 3, 194);
  entry(100, 5, 1, 1, 0);
  entry(112, 6, 5, 1, 218);
  entry(124, 16, 2, 2, 84);
  entry(136, 17, 5, 1, 226);
  tiff.setUint16(152, 1, little);
  entry(154, 0xa405, 3, 1, 26);
  [43, 39, 11, 79, 23, 0, 120, 245].forEach((number, index) => {
    tiff.setUint32(170 + index * 8, number, little);
    tiff.setUint32(174 + index * 8, 1, little);
  });
  bytes.set([0xff, 0xd9], 246);
  return bytes;
}

const toronto: CitySceneConfig = {
  id: "toronto",
  country: "canada",
  region: "toronto",
  name: "Toronto",
  description: "Toronto scene",
  publicMap: "google-2d-3d",
  center: { latitude: 43.65, longitude: -79.38, altitudeM: 100 },
  bounds: { west: -79.5, east: -79.2, south: 43.5, north: 43.8 },
  defaultCamera: { headingDeg: 0, pitchDeg: -35, rangeM: 500 },
  coverage: { photorealistic: "expected", osmBuildings: "expected" },
  pilotPhotoIds: [],
  samplePhotoIds: [],
};
const image = { url: "blob:local-test", width: 1_200, height: 800 };

describe("private photo metadata", () => {
  it.each([true, false])(
    "reads GPS and optics from a %s-endian JPEG without extracting timestamps",
    (little) => {
      const metadata = readPhotoMetadata(jpegWithExif(little).buffer);
      expect(metadata.latitude).toBeCloseTo(43.65305556);
      expect(metadata.longitude).toBeCloseTo(-79.38333333);
      expect(metadata.altitudeM).toBe(120);
      expect(metadata.headingDeg).toBe(245);
      expect(metadata.headingReference).toBe("T");
      expect(metadata.focalLength35Mm).toBe(26);
      expect(metadata.orientation).toBe(6);
      expect(Object.keys(metadata).sort()).toEqual([
        "altitudeM",
        "focalLength35Mm",
        "headingDeg",
        "headingReference",
        "latitude",
        "longitude",
        "orientation",
      ]);
    },
  );

  it("reads PNG and WebP EXIF containers", () => {
    const tiff = jpegWithExif().subarray(12, 246);
    const png = new Uint8Array(tiff.length + 20);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    new DataView(png.buffer).setUint32(8, tiff.length);
    png.set([101, 88, 73, 102], 12);
    png.set(tiff, 16);
    const webp = new Uint8Array(tiff.length + 20);
    webp.set([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 69, 88, 73, 70]);
    new DataView(webp.buffer).setUint32(16, tiff.length, true);
    webp.set(tiff, 20);
    expect(readPhotoMetadata(png.buffer).latitude).toBeCloseTo(43.65305556);
    expect(readPhotoMetadata(webp.buffer).latitude).toBeCloseTo(43.65305556);
  });

  it("does not invent a hemisphere when a GPS reference is missing", () => {
    const bytes = jpegWithExif();
    bytes[12 + 52 + 8] = 0;
    const metadata = readPhotoMetadata(bytes.buffer);
    expect(metadata.latitude).toBeUndefined();
    expect(metadata.longitude).toBeUndefined();
  });

  it("rejects invalid rational data and handles every truncated input safely", () => {
    const bytes = jpegWithExif();
    for (let length = 0; length < bytes.length; length += 1)
      expect(() =>
        readPhotoMetadata(bytes.slice(0, length).buffer),
      ).not.toThrow();
    new DataView(bytes.buffer).setUint32(12 + 174, 0, true);
    expect(readPhotoMetadata(bytes.buffer).latitude).toBeUndefined();
    expect(readPhotoMetadata(new ArrayBuffer(0))).toEqual({});
  });

  it("ignores an out-of-bounds IFD pointer", () => {
    const bytes = jpegWithExif();
    new DataView(bytes.buffer).setUint32(12 + 18, 0xffffffff, true);
    expect(readPhotoMetadata(bytes.buffer).latitude).toBeUndefined();
  });
});

describe("local camera preparation", () => {
  it("matches featured city bounds without assigning a distant nearest city", () => {
    expect(matchPhotoCity(43.65, -79.38, [toronto])?.id).toBe("toronto");
    expect(matchPhotoCity(51.5, -0.12, [toronto])).toBeUndefined();
  });

  it("creates an explicitly approximate scene with no publishing or projection permission", () => {
    const scene = createUploadScene(
      readPhotoMetadata(jpegWithExif().buffer),
      image,
      [toronto],
    );
    expect(scene.city.id).toBe("toronto");
    expect(scene.photo.pose).toMatchObject({
      calibration: "approximate",
      headingDeg: 245,
      pitchDeg: 0,
      rollDeg: 0,
      confidence: 0,
    });
    expect(scene.photo.highlight.approved).toBe(false);
    expect(scene.photo.capabilities.projection).toBe(false);
    expect(scene.photo.privacy).toEqual({
      location: "hidden",
      timestamp: "hidden",
    });
    expect(scene.photo.image.url).toBe("blob:local-test");
  });

  it("does not pass a magnetic bearing off as true north", () => {
    const scene = createUploadScene(
      {
        latitude: 43.65,
        longitude: -79.38,
        headingDeg: 245,
        headingReference: "M",
      },
      image,
      [toronto],
    );
    expect(scene.photo.pose.headingDeg).toBe(0);
    expect(scene.hasTrueHeading).toBe(false);
  });

  it("supports manual fallback, zero coordinates, and custom locations", () => {
    const scene = createUploadScene({}, image, [toronto], {
      latitude: 0,
      longitude: 0,
      altitudeM: 20,
    });
    expect(scene.city.id).toBe("custom-location");
    expect(scene.photo.pose.source).toBe("manual");
    expect(scene.photo.location.original).toEqual({
      latitude: 0,
      longitude: 0,
      altitudeM: 20,
    });
    expect(() => createUploadScene({}, image, [toronto])).toThrow(
      /latitude and longitude/,
    );
    expect(() =>
      createUploadScene({}, image, [toronto], { latitude: NaN, longitude: 0 }),
    ).toThrow();
  });

  it("derives consistent lens angles for both landscape and portrait display", () => {
    const landscape = photoFieldOfView(1_200, 800, 50);
    const portrait = photoFieldOfView(800, 1_200, 50);
    expect(landscape.horizontalFovDeg).toBeCloseTo(39.59775);
    expect(portrait.verticalFovDeg).toBeCloseTo(landscape.horizontalFovDeg);
    expect(portrait.horizontalFovDeg).toBeCloseTo(landscape.verticalFovDeg);
  });

  it("keeps custom bounds valid at the poles and antimeridian", () => {
    for (const latitude of [-90, 90]) {
      for (const longitude of [-180, 180]) {
        const { city } = createUploadScene({}, image, [], {
          latitude,
          longitude,
        });
        expect(city.bounds.west).toBeGreaterThanOrEqual(-180);
        expect(city.bounds.east).toBeLessThanOrEqual(180);
        expect(city.bounds.south).toBeGreaterThanOrEqual(-90);
        expect(city.bounds.north).toBeLessThanOrEqual(90);
        expect(city.bounds.west).toBeLessThan(city.bounds.east);
        expect(city.bounds.south).toBeLessThan(city.bounds.north);
      }
    }
  });

  it("rejects unusable dimensions and lens values before constructing a frustum", () => {
    for (const dimensions of [
      [0, 800],
      [1200, -1],
      [Infinity, 800],
      [NaN, 800],
    ])
      expect(() => photoFieldOfView(dimensions[0], dimensions[1], 28)).toThrow(
        /dimensions/,
      );
    for (const focal of [0, -1, NaN, Infinity])
      expect(() => photoFieldOfView(1200, 800, focal)).toThrow(/focal length/);
    expect(() => photoFieldOfView(1200, 800, Number.MIN_VALUE)).toThrow(
      /field of view/,
    );
  });
});
