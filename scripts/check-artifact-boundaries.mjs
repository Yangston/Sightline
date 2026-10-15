import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const distRoot = path.join(root, "dist");
const vercelStaticRoot = path.join(root, ".vercel", "output", "static");
const publicOrigin = "https://sightline.stoneyang.ca";
const removedRoutes = /^\/(?:ar|demo|live-demo|upload)(?:\/|\.html$|$)/i;
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
const artifactRoots = [distRoot];
try {
  if ((await stat(vercelStaticRoot)).isDirectory())
    artifactRoots.push(vercelStaticRoot);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function checkPageLinks(source, filename, artifactRoot) {
  const relative = path.relative(artifactRoot, filename).replaceAll("\\", "/");
  const pathname = `/${relative.replace(/index\.html$/, "")}`;
  if (removedRoutes.test(pathname))
    throw new Error(`${path.relative(root, filename)} emits a removed route.`);

  // Inspect rendered anchors, not link examples inside bundled scripts or styles.
  const html = source.replace(
    /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    "",
  );
  const anchors = html.matchAll(
    /<(?:a|area)\b[^>]*\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
  );
  for (const match of anchors) {
    const href = match[1] ?? match[2] ?? match[3];
    let link;
    try {
      link = new URL(
        href.replaceAll("&amp;", "&"),
        `${publicOrigin}${pathname}`,
      );
    } catch {
      continue;
    }
    if (link.origin === publicOrigin && removedRoutes.test(link.pathname))
      throw new Error(
        `${path.relative(root, filename)} links to a removed route.`,
      );
    if (
      /^(?:www\.)?github\.com$/i.test(link.hostname) &&
      /^\/Yangston\/Sightline(?:\.git)?(?:\/|$)/i.test(link.pathname)
    )
      throw new Error(
        `${path.relative(root, filename)} exposes the repository link.`,
      );
  }
}

let fileCount = 0;
for (const artifactRoot of artifactRoots) {
  const files = await walk(artifactRoot);
  fileCount += files.length;
  for (const filename of files) {
    const source = await readFile(filename, "utf8");
    for (const [pattern, label] of forbidden)
      if (pattern.test(source))
        throw new Error(
          `${path.relative(root, filename)} contains a ${label}.`,
        );
    if (path.extname(filename) === ".html")
      checkPageLinks(source, filename, artifactRoot);
  }
  for (const route of [
    "photography/calibrate",
    "photography/auto-calibration",
  ]) {
    const filename = path.join(artifactRoot, route, "index.html");
    const routeStat = await stat(filename);
    const source = await readFile(filename, "utf8");
    if (
      routeStat.size > 2048 ||
      /component-url|renderer-url|\.js["']/.test(source)
    )
      throw new Error(
        `${path.relative(root, filename)} emitted client code instead of a production redirect.`,
      );
  }
}
console.log(
  `Artifact boundary verified across ${fileCount} text files in ${artifactRoots.length} build outputs.`,
);
