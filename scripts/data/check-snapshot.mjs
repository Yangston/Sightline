import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const dataRoot = path.join(root, "src", "data");
const mediaRoot = path.join(root, "public", "media", "photography");
const snapshotPath = path.join(dataRoot, "sightline-snapshot.json");
const digestFiles = [
  ...[
    "photography-manifest.json",
    "photography-audit.json",
    "photography-integrity.json",
    "photography-map-records.json",
    "photography-auto-pilots.json",
    "photography-auto-rejections.json",
    "photography-image-only-pilots.json",
    "photography-image-only-rejections.json",
    "photography-image-only-evaluations.json",
  ].map((name) => ({ name, filename: path.join(dataRoot, name) })),
  {
    name: "config/photography.json",
    filename: path.join(root, "src", "config", "photography.json"),
  },
  {
    name: "config/photography-publication.json",
    filename: path.join(root, "src", "config", "photography-publication.json"),
  },
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readJson = async (filename) =>
  JSON.parse(await readFile(path.join(dataRoot, filename), "utf8"));

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(filename)));
    else files.push(filename);
  }
  return files;
}

const manifest = await readJson("photography-manifest.json");
const integrity = await readJson("photography-integrity.json");
const mapRecords = await readJson("photography-map-records.json");
const manifestIds = new Set(manifest.map(({ id }) => id));
if (manifestIds.size !== manifest.length)
  throw new Error("The public manifest contains duplicate IDs.");
for (const [label, records] of [
  ["integrity", integrity],
  ["map", mapRecords],
]) {
  const ids = new Set(records.map(({ id }) => id));
  if (
    ids.size !== manifestIds.size ||
    [...manifestIds].some((id) => !ids.has(id))
  )
    throw new Error(`${label} membership does not match the manifest.`);
}

const expectedMedia = new Set();
let expectedBytes = 0;
for (const record of integrity) {
  for (const variant of record.variants) {
    const relative = variant.src.replace(/^\/media\/photography\//, "");
    const filename = path.join(mediaRoot, ...relative.split("/"));
    const bytes = await readFile(filename);
    const info = await stat(filename);
    if (info.size !== variant.bytes || sha256(bytes) !== variant.digest)
      throw new Error(`Media digest mismatch: ${variant.src}`);
    expectedMedia.add(path.resolve(filename));
    expectedBytes += info.size;
  }
}
const actualMedia = (await walk(mediaRoot)).map((filename) =>
  path.resolve(filename),
);
const orphans = actualMedia.filter((filename) => !expectedMedia.has(filename));
if (actualMedia.length !== expectedMedia.size || orphans.length)
  throw new Error(
    `Media membership mismatch (${orphans.length} orphaned files).`,
  );

const fileDigests = {};
for (const { name, filename } of digestFiles)
  fileDigests[name] = sha256(await readFile(filename));
const datasetDigest = sha256(
  Object.entries(fileDigests)
    .map(([name, digest]) => `${name}:${digest}`)
    .join("\n"),
);
const snapshot = {
  schemaVersion: 1,
  snapshotId: "portfolio-2026-08-10",
  sourceRepository: "Yangston/Personal-Website",
  records: manifest.length,
  mediaFiles: actualMedia.length,
  mediaBytes: expectedBytes,
  datasetDigest,
  fileDigests,
};

if (process.argv.includes("--write")) {
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
} else {
  const committed = JSON.parse(await readFile(snapshotPath, "utf8"));
  if (JSON.stringify(committed) !== JSON.stringify(snapshot))
    throw new Error("Snapshot metadata is stale. Re-import or regenerate it.");
}
console.log(
  `Sightline snapshot verified: ${snapshot.records} records, ${snapshot.mediaFiles} media files, ${snapshot.datasetDigest.slice(0, 12)}.`,
);
