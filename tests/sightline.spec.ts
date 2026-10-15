import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import mapRecords from "../src/data/photography-map-records.json" with { type: "json" };
import { makePhotoFixture } from "./support/photo-fixture";

const productionPreview = process.env.PLAYWRIGHT_USE_PREVIEW === "1";
// The development server compiles Cesium on first use; built pages retain the
// ordinary interaction budget so development compilation cannot mask regressions.
const viewerStartupTimeout = productionPreview ? 20_000 : 90_000;

const alignmentPhoto = mapRecords.find(
  (photo) => photo.sceneId === "san-francisco" && photo.capabilities.comparison,
)!;
const emptyTileset = {
  asset: { version: "1.1", copyright: "Synthetic test scene" },
  geometricError: 0,
  root: {
    boundingVolume: { sphere: [0, 0, 0, 1] },
    geometricError: 0,
    refine: "ADD",
  },
};
const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1EAAAAASUVORK5CYII=",
  "base64",
);

async function installMapFixture(context: BrowserContext) {
  await context.route("https://tile.googleapis.com/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/createSession")) {
      await route.fulfill({ json: { session: "synthetic-session" } });
    } else if (pathname.endsWith("/viewport")) {
      await route.fulfill({ json: { copyright: "Synthetic test map" } });
    } else if (pathname.includes("/2dtiles/")) {
      await route.fulfill({ contentType: "image/png", body: transparentPng });
    } else if (pathname.endsWith("/root.json")) {
      await route.fulfill({ json: emptyTileset });
    } else {
      await route.abort();
    }
  });
}

async function expectResponsiveViewport(page: Page) {
  try {
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        { timeout: 5_000 },
      )
      .toBe(true);
  } catch (error) {
    const dimensions = await page.evaluate(() => ({
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      offenders: [...document.body.querySelectorAll("*")]
        .map((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            tag: element.tagName,
            id: element.id,
            className: element.getAttribute("class"),
            width: bounds.width,
            right: bounds.right,
          };
        })
        .filter(({ right }) => right > innerWidth + 1)
        .slice(0, 12),
    }));
    await test.info().attach("overflow-diagnostics", {
      body: JSON.stringify(dimensions, null, 2),
      contentType: "application/json",
    });
    throw error;
  }
}

test.beforeEach(async ({ context }) => {
  // Exercise the real viewer without fetching or storing provider imagery.
  await installMapFixture(context);
});

test("landing page explains the product and exposes the dataset", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Return to the original/ }),
  ).toBeVisible();
  await expect(page.locator(".sightline-hero-scene img").first()).toBeVisible();
  await expect(page.getByText("149", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Explore reconstructions" }).click();
  await expect(page).toHaveURL(/\/explore$/);
  await expect(page.locator(".scene-card")).toHaveCount(10);
  await page.locator('[data-scene-filter="interactive"]').click();
  await expect(page.locator(".scene-card:visible")).toHaveCount(3);
  await page.locator('[data-scene-filter="photography"]').click();
  await expect(page.locator(".scene-card:visible")).toHaveCount(7);
  await page.locator('[data-scene-filter="all"]').click();
  await expect(page.locator(".scene-card:visible")).toHaveCount(10);
});

test("camera controls render a frustum and retain comparison through resizing", async ({
  page,
}) => {
  if (!productionPreview) test.slow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/explore/san-francisco?photo=${alignmentPhoto.id}`);
  await page.getByRole("button", { name: "View camera frustum" }).click();
  await expect(
    page.getByRole("button", { name: "Hide frustum" }),
  ).toHaveAttribute("aria-pressed", "true", { timeout: viewerStartupTimeout });
  await expect(page.locator(".cesium-widget canvas")).toBeVisible();
  await page
    .getByRole("button", { name: "Compare photo", exact: true })
    .click();
  const comparison = page.locator(".city-map-camera-comparison");
  await expect(comparison).toBeVisible();
  await expect(comparison).toHaveCSS("object-fit", "contain");
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(comparison).toBeVisible();
  await expectResponsiveViewport(page);
  await page.getByRole("button", { name: "2D satellite", exact: true }).click();
  await expect(page.locator(".cesium-widget canvas")).toHaveCount(0);
  await expect(comparison).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a canceled 3D load disposes its late scene and can be opened again", async ({
  page,
}) => {
  if (!productionPreview) test.slow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let releaseRoot: (() => void) | undefined;
  let signalRequested: (() => void) | undefined;
  const rootRequested = new Promise<void>((resolve) => {
    signalRequested = resolve;
  });
  const rootReleased = new Promise<void>((resolve) => {
    releaseRoot = resolve;
  });
  let firstRoot = true;
  await page.route(
    "https://tile.googleapis.com/**/root.json?*",
    async (route) => {
      if (firstRoot) {
        firstRoot = false;
        signalRequested?.();
        await rootReleased;
      }
      await route.fulfill({ json: emptyTileset }).catch(() => {});
    },
  );
  await page.goto(`/explore/san-francisco?photo=${alignmentPhoto.id}`);
  await page.locator("[data-open-3d]").click();
  await rootRequested;
  await page.getByRole("button", { name: "2D satellite", exact: true }).click();
  releaseRoot?.();
  await expect(page.locator("[data-city-map-experience]")).toHaveAttribute(
    "data-city-map-mode",
    "2d",
  );
  await expect(page.locator(".cesium-widget canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "View camera frustum" }).click();
  await expect(page.getByRole("button", { name: "Hide frustum" })).toBeVisible({
    timeout: viewerStartupTimeout,
  });
  expect(errors).toEqual([]);
});

test("provider failure restores 2D and allows a clean retry", async ({
  page,
}) => {
  if (!productionPreview) test.slow();
  let failing = true;
  await page.route(
    "https://tile.googleapis.com/**/root.json?*",
    async (route) => {
      await route.fulfill(
        failing
          ? { status: 503, body: "Synthetic provider failure" }
          : { json: emptyTileset },
      );
    },
  );
  await page.goto(`/explore/san-francisco?photo=${alignmentPhoto.id}`);
  const failedProvider = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/root.json") &&
      response.status() === 503,
    { timeout: viewerStartupTimeout },
  );
  await page.locator("[data-open-3d]").click();
  await failedProvider;
  await expect(page.locator(".city-atlas-status")).toContainText(
    /could not start/i,
  );
  await expect(page.locator(".cesium-widget canvas")).toHaveCount(0);
  failing = false;
  await page.getByRole("button", { name: "View camera frustum" }).click();
  await expect(page.getByRole("button", { name: "Hide frustum" })).toBeVisible({
    timeout: viewerStartupTimeout,
  });
});

test("gallery keyboard navigation restores focus to the opened photograph", async ({
  page,
}) => {
  await page.goto("/explore/san-francisco");
  const opener = page.locator(".city-lightbox-trigger").first();
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.locator("p")).toContainText(/^2 \/ /);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});

test("all public sections fit a 320 pixel screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  for (const route of [
    "/",
    "/explore",
    "/explore/san-francisco",
    "/methodology",
    "/upload",
  ]) {
    await page.goto(route);
    await expect(page.locator("h1")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `Horizontal overflow at ${route}`,
    ).toBe(true);
  }
});

test("photographs and page navigation remain available without JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  await installMapFixture(context);
  const page = await context.newPage();
  await page.goto(
    "http://127.0.0.1:" +
      (process.env.PLAYWRIGHT_PORT ?? "4333") +
      "/explore/san-francisco",
  );
  await expect(
    page.getByRole("heading", { name: "San Francisco", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-manifest-id]")).toHaveCount(15);
  await expect(page.locator("[data-manifest-id] img").first()).toBeVisible();
  await page
    .getByRole("link", { name: "Explore", exact: true })
    .first()
    .click();
  await expect(page.locator(".scene-card")).toHaveCount(10);
  await page.goto(
    "http://127.0.0.1:" + (process.env.PLAYWRIGHT_PORT ?? "4333") + "/upload",
  );
  await expect(
    page.getByText(/Enable JavaScript to read a local photo/),
  ).toBeVisible();
  await expect(
    page.getByLabel("Choose a photograph", { exact: true }),
  ).toBeDisabled();
  await context.close();
});

test("a local photograph detects its city before explicitly opening 3D", async ({
  page,
}) => {
  if (!productionPreview) test.slow();
  const providerRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://tile.googleapis.com/"))
      providerRequests.push(request.url());
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/upload");
  await expect(
    page.getByLabel("Choose a photograph", { exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Choose a photograph", { exact: true }).setInputFiles({
    name: "synthetic-toronto.jpg",
    mimeType: "image/jpeg",
    buffer: await makePhotoFixture(),
  });
  await expect(page.locator("[data-upload-result]")).toBeVisible();
  await expect(page.locator("[data-upload-city]")).toHaveText("Toronto");
  await expect(page.locator("[data-upload-gps]")).toContainText(
    "from metadata",
  );
  await expect(page.locator("[data-upload-open]")).toBeEnabled();
  expect(providerRequests).toEqual([]);
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
  await page.locator("[data-upload-open]").click();
  await expect(page.locator("[data-upload-canvas] canvas")).toBeVisible({
    timeout: viewerStartupTimeout,
  });
  await expect(page.locator("[data-upload-viewer-status]")).toContainText(
    /ready/i,
    { timeout: viewerStartupTimeout },
  );
  await page
    .getByRole("button", { name: "Match photo view", exact: true })
    .click();
  await expect(page.locator("[data-upload-overlay]")).toBeVisible();
  await page.setViewportSize({ width: 320, height: 720 });
  await expectResponsiveViewport(page);
  await page.getByRole("button", { name: "Close 3D", exact: true }).click();
  await expect(page.locator("[data-upload-canvas] canvas")).toHaveCount(0);
  await expect(page.locator("[data-upload-open]")).toBeFocused();
  await page.getByRole("button", { name: "Remove photo", exact: true }).click();
  await expect(page.locator("[data-upload-result]")).not.toBeVisible();
  await expect(page.locator("[data-upload-image]")).not.toHaveAttribute("src");
  await expect(
    page.getByLabel("Choose a photograph", { exact: true }),
  ).toBeFocused();
  await page.getByLabel("Choose a photograph", { exact: true }).setInputFiles({
    name: "replacement-without-gps.jpg",
    mimeType: "image/jpeg",
    buffer: await makePhotoFixture(false),
  });
  await expect(page.locator("[data-upload-status]")).toContainText(
    "No GPS metadata",
  );
  await expect(page.locator("[data-upload-open]")).toBeDisabled();
});

test("a photo without GPS clearly requests a location and prepares a manual scene", async ({
  page,
}) => {
  await page.goto("/upload");
  await expect(
    page.getByLabel("Choose a photograph", { exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Choose a photograph", { exact: true }).setInputFiles({
    name: "synthetic-no-gps.jpg",
    mimeType: "image/jpeg",
    buffer: await makePhotoFixture(false),
  });
  await expect(page.locator("[data-upload-status]")).toContainText(
    "No GPS metadata",
  );
  await expect(page.locator("[data-upload-open]")).toBeDisabled();
  await page.getByLabel("Latitude", { exact: true }).fill("43.65");
  await page.getByLabel("Longitude", { exact: true }).fill("-79.38");
  await page
    .getByRole("button", { name: "Prepare scene", exact: true })
    .click();
  await expect(page.locator("[data-upload-city]")).toHaveText("Toronto");
  await expect(page.locator("[data-upload-gps]")).toContainText(
    "entered location",
  );
  await expect(page.locator("[data-upload-open]")).toBeEnabled();
});

test("San Francisco restores the image-only method without eager Cesium", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(
    "/explore/san-francisco?reconstruction=image-only&photo=img-7540",
  );
  const experience = page.locator("[data-city-map-experience]");
  await expect(experience).toHaveAttribute(
    "data-reconstruction-method",
    "image-only",
  );
  await expect(
    page.getByRole("button", { name: "Image-only (no file metadata)" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-photo-id="img-7540"]')).toContainText(
    "Outside image-only pilot area",
  );
  expect(requests.some((url) => /scene\.json|\/cesium\//i.test(url))).toBe(
    false,
  );
});

test("gallery-only scenes retain complete durable photographs", async ({
  page,
}) => {
  await page.goto("/explore/elora");
  await expect(page.locator("[data-city-map-experience]")).toHaveCount(0);
  await expect(page.locator("[data-gallery-ready='true']")).toBeVisible();
  await expect(page.locator("[data-manifest-id]")).toHaveCount(1);
});

test("development calibration routes are production-safe redirects", async ({
  request,
}) => {
  const production = process.env.PLAYWRIGHT_USE_PREVIEW === "1";
  for (const route of [
    "/photography/calibrate",
    "/photography/auto-calibration",
  ]) {
    const response = await request.get(route, { maxRedirects: 0 });
    if (!production) {
      expect(response.status()).toBe(200);
      const html = await response.text();
      expect(html).toContain(
        route.endsWith("auto-calibration")
          ? "Automatic Sightline calibration harness"
          : "Pose calibration",
      );
      continue;
    }
    expect([200, 301, 302, 307, 308, 404]).toContain(response.status());
    if (response.status() === 200) {
      const html = await response.text();
      expect(html).toContain("Redirecting to: /404");
      expect(html).not.toContain("data-auto-calibration-ready");
      expect(html).not.toContain("Development-only camera pose calibration");
    }
  }
});
