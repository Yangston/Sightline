import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const distRoot = path.join(root, "dist");
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".txt",
  ".xml",
]);
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(filename)));
    else if (textExtensions.has(path.extname(entry.name))) files.push(filename);
  }
  return files;
}
const forbidden = [
  [/\.private[\\/]/i, "private workspace path"],
  [/[A-Z]:\\Users\\/i, "Windows user path"],
  [/\/Users\/[^/]+\//, "macOS user path"],
  [
    /captureDate.{0,120}\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/i,
    "exact capture timestamp",
  ],
  [
    /Automatic photo calibration harness|Load a scene to begin calibration|Copy this JSON into the pilot seed/i,
    "development calibration client",
  ],
];
const files = await walk(distRoot);
for (const filename of files) {
  const source = await readFile(filename, "utf8");
  for (const [pattern, label] of forbidden)
    if (pattern.test(source))
      throw new Error(`${path.relative(root, filename)} contains a ${label}.`);
}
for (const route of ["photography/calibrate", "photography/auto-calibration"]) {
  const filename = path.join(distRoot, route, "index.html");
  const routeStat = await stat(filename);
  const source = await readFile(filename, "utf8");
  if (
    routeStat.size > 2048 ||
    /component-url|renderer-url|\.js["']/.test(source)
  )
    throw new Error(
      `/${route} emitted client code instead of a production redirect.`,
    );
}
console.log(`Artifact boundary verified across ${files.length} text files.`);
