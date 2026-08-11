import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const fromArg = process.argv
  .slice(2)
  .find((value) => value.startsWith("--from="));
if (!fromArg) throw new Error("Use --from=<portfolio-path>.");
const source = path.resolve(fromArg.slice("--from=".length));
const target = process.cwd();
const galleryData = [
  "photography-manifest.json",
  "photography-audit.json",
  "photography-integrity.json",
];
for (const name of galleryData) {
  const filename = path.join(source, "src", "data", name);
  JSON.parse(await readFile(filename, "utf8"));
}
const sourcePublication = JSON.parse(
  await readFile(
    path.join(source, "src", "config", "photography-publication.json"),
    "utf8",
  ),
);
const targetPublicationPath = path.join(
  target,
  "src",
  "config",
  "photography-publication.json",
);
const targetPublication = JSON.parse(
  await readFile(targetPublicationPath, "utf8"),
);
const sourcePublicationById = new Map(
  sourcePublication.map((record) => [record.id, record]),
);
const targetPublicationById = new Map(
  targetPublication.map((record) => [record.id, record]),
);
const sourceManifest = JSON.parse(
  await readFile(
    path.join(source, "src", "data", "photography-manifest.json"),
    "utf8",
  ),
);
const mergedPublication = sourceManifest.map(({ id }) => {
  const galleryRecord = sourcePublicationById.get(id);
  const sightlineRecord = targetPublicationById.get(id);
  if (!galleryRecord)
    throw new Error(`Portfolio publication policy is missing ${id}.`);
  if (!sightlineRecord)
    throw new Error(
      `Sightline publication policy is missing ${id}; review its reconstruction privacy before importing.`,
    );
  return {
    ...sightlineRecord,
    alt: galleryRecord.alt,
    timestamp: galleryRecord.timestamp,
  };
});

const staging = path.join(target, ".private", "snapshot-import");
await rm(staging, { recursive: true, force: true });
await mkdir(path.join(staging, "data"), { recursive: true });
for (const name of galleryData)
  await cp(
    path.join(source, "src", "data", name),
    path.join(staging, "data", name),
  );
await cp(
  path.join(source, "public", "media", "photography"),
  path.join(staging, "media"),
  { recursive: true },
);
await writeFile(
  path.join(staging, "photography-publication.json"),
  `${JSON.stringify(mergedPublication, null, 2)}\n`,
);

for (const name of galleryData)
  await cp(
    path.join(staging, "data", name),
    path.join(target, "src", "data", name),
  );
await rm(path.join(target, "public", "media", "photography"), {
  recursive: true,
  force: true,
});
await cp(
  path.join(staging, "media"),
  path.join(target, "public", "media", "photography"),
  { recursive: true },
);
await cp(
  path.join(staging, "photography-publication.json"),
  targetPublicationPath,
);
await rm(staging, { recursive: true, force: true });

const check = spawn(
  process.execPath,
  [path.join("scripts", "data", "check-snapshot.mjs"), "--write"],
  {
    cwd: target,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);
check.on("exit", (code) => process.exit(code ?? 1));
