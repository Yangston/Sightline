import sharp from "sharp";

export async function makePhotoFixture(withGps = true) {
  const image = await sharp({
    create: {
      width: 640,
      height: 480,
      channels: 3,
      background: { r: 98, g: 132, b: 160 },
    },
  })
    .jpeg()
    .toBuffer();
  if (!withGps) return image;

  // A synthetic standard TIFF GPS IFD: Toronto, without any private photo data.
  const tiff = Buffer.alloc(128);
  tiff.write("II", 0);
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt16LE(4, 26);
  for (const [index, tag, type, count, value] of [
    [0, 1, 2, 2, 0],
    [1, 2, 5, 3, 80],
    [2, 3, 2, 2, 0],
    [3, 4, 5, 3, 104],
  ]) {
    const offset = 28 + index * 12;
    tiff.writeUInt16LE(tag, offset);
    tiff.writeUInt16LE(type, offset + 2);
    tiff.writeUInt32LE(count, offset + 4);
    tiff.writeUInt32LE(value, offset + 8);
  }
  tiff.write("N", 36);
  tiff.write("W", 60);
  for (const [index, numerator] of [43, 39, 0, 79, 22, 48].entries()) {
    tiff.writeUInt32LE(numerator, 80 + index * 8);
    tiff.writeUInt32LE(1, 84 + index * 8);
  }
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const marker = Buffer.from([0xff, 0xe1, 0, 0]);
  marker.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([image.subarray(0, 2), marker, exif, image.subarray(2)]);
}
