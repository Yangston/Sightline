import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const scriptsRoot = path.resolve("scripts/data");

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writeJson(filename: string, value: unknown) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

async function makeRepository(root: string, alt = "Original description") {
  const media = Buffer.from("responsive-webp-fixture");
  const digest = createHash("sha256").update(media).digest("hex");
  const src = "/media/photography/example/photo-480.webp";
  const manifest = [
    {
      id: "photo",
      source: "Example/city/photo.jpg",
      country: "example",
      region: "city",
      captureDate: "2026-08-10",
      width: 480,
      height: 320,
      alt,
      variants: [{ width: 480, src }],
    },
  ];
  const integrity = [
    {
      id: "photo",
      source: "Example/city/photo.jpg",
      sourceBytes: 1,
      sourceDigest: "0".repeat(64),
      variants: [{ width: 480, height: 320, src, bytes: media.length, digest }],
    },
  ];
  await Promise.all([
    writeJson(path.join(root, "src/data/photography-manifest.json"), manifest),
    writeJson(path.join(root, "src/data/photography-audit.json"), [
      { id: "photo" },
    ]),
    writeJson(
      path.join(root, "src/data/photography-integrity.json"),
      integrity,
    ),
    writeJson(path.join(root, "src/data/photography-map-records.json"), [
      { id: "photo" },
    ]),
    ...[
      "photography-auto-pilots.json",
      "photography-auto-rejections.json",
      "photography-image-only-pilots.json",
      "photography-image-only-rejections.json",
      "photography-image-only-evaluations.json",
    ].map((name) => writeJson(path.join(root, "src/data", name), [])),
    writeJson(path.join(root, "src/config/photography.json"), {
      regions: [],
      cities: [],
    }),
    writeJson(path.join(root, "src/config/photography-publication.json"), [
      { id: "photo", alt, timestamp: "date", location: "exact" },
    ]),
  ]);
  const mediaPath = path.join(
    root,
    "public/media/photography/example/photo-480.webp",
  );
  await mkdir(path.dirname(mediaPath), { recursive: true });
  await writeFile(mediaPath, media);
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await cp(scriptsRoot, path.join(root, "scripts/data"), { recursive: true });
  return { manifest, integrity, media, mediaPath };
}

describe("Sightline snapshot releases", () => {
  it("detects digest failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sightline-snapshot-"));
    temporaryRoots.push(root);
    const { mediaPath } = await makeRepository(root);
    const checker = path.join(root, "scripts/data/check-snapshot.mjs");

    await execFileAsync(process.execPath, [checker, "--write"], { cwd: root });
    await execFileAsync(process.execPath, [checker], { cwd: root });
    await writeFile(mediaPath, "tampered");
    await expect(
      execFileAsync(process.execPath, [checker], { cwd: root }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Media digest mismatch"),
    });
  });

  it("imports gallery assets while preserving reconstruction privacy", async () => {
    const target = await mkdtemp(path.join(tmpdir(), "sightline-target-"));
    const source = await mkdtemp(path.join(tmpdir(), "sightline-source-"));
    temporaryRoots.push(target, source);
    const targetFixture = await makeRepository(target);
    const sourceFixture = await makeRepository(source, "Reviewed gallery copy");
    await writeJson(
      path.join(source, "src/config/photography-publication.json"),
      [
        {
          id: "photo",
          alt: "Reviewed gallery copy",
          timestamp: "hidden",
        },
      ],
    );
    await writeJson(
      path.join(source, "src/data/photography-manifest.json"),
      sourceFixture.manifest.map((record) => ({
        ...record,
        alt: "Reviewed gallery copy",
      })),
    );

    const importer = path.join(target, "scripts/data/import-snapshot.mjs");
    await execFileAsync(process.execPath, [importer, `--from=${source}`], {
      cwd: target,
    });

    const publication = JSON.parse(
      await readFile(
        path.join(target, "src/config/photography-publication.json"),
        "utf8",
      ),
    );
    expect(publication).toEqual([
      {
        id: "photo",
        alt: "Reviewed gallery copy",
        timestamp: "hidden",
        location: "exact",
      },
    ]);
    expect(await readFile(targetFixture.mediaPath)).toEqual(
      sourceFixture.media,
    );
  });
});
