import { createHash } from "node:crypto";
import sharp from "sharp";

export async function sanitizeImageOnlyPixels(sourcePath, outputPath) {
  await sharp(sourcePath, { failOn: "error" })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(outputPath);
  const { data, info } = await sharp(outputPath)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    pixelDigest: createHash("sha256").update(data).digest("hex"),
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}
