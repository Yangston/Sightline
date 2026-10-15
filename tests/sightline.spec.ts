import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import mapRecords from "../src/data/photography-map-records.json" with { type: "json" };

const productionPreview = process.env.PLAYWRIGHT_USE_PREVIEW === "1";
// The development server compiles Cesium on first use; built pages retain the
// ordinary interaction budget so development compilation cannot mask regressions.
const viewerStartupTimeout = productionPreview ? 20_000 : 90_000;

const alignmentPhoto = mapRecords.find(
  (photo) => photo.sceneId === "san-francisco" && photo.capabilities.comparison,
)!;
const startingPhotos = [
  ["san-francisco", "img-7561"],
  ["toronto", "img-7449"],
] as const;
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

test("the home collection shows only San Francisco and Toronto with their starting photographs", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /A place\.\s*A point of view\./ }),
  ).toBeVisible();
  const cards = page.locator(".scene-card");
  await expect(cards).toHaveCount(2);
  for (const [index, [city, photo]] of startingPhotos.entries()) {
    await expect(cards.nth(index)).toHaveAttribute(
      "href",
      `/explore/${city}?view=3d`,
    );
    await expect(cards.nth(index).locator("img")).toHaveAttribute(
      "src",
      new RegExp(photo),
    );
    await expect(cards.nth(index)).toContainText("Open 3D view");
  }
  await expect(page.locator("[data-scene-filter]")).toHaveCount(0);
  await expect(page.locator(".city-gallery")).toHaveCount(0);
});

test("the former explore page redirects to the collection", async ({
  page,
}) => {
  await page.goto("/explore");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".scene-card")).toHaveCount(2);
});

test("removed demonstrations and repository links are absent from public navigation", async ({
  page,
  request,
}) => {
  for (const route of ["/", "/explore/san-francisco", "/methodology"]) {
    await page.goto(route);
    await expect(
      page.locator(
        'a[href*="github.com"], a[href="/upload"], a[href="/ar"], a[href="/live-demo"]',
      ),
    ).toHaveCount(0);
  }
  const response = await request.get("/upload");
  expect(response.status()).toBe(404);
});

for (const [city, photo] of startingPhotos) {
  test(`${city} starts with ${photo} without loading 3D`, async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(`/explore/${city}`);
    await expect(page.locator(".city-selected-photo strong")).toHaveText(photo);
    await expect(page.locator("[data-open-3d]")).toBeEnabled();
    await expect(page.locator(".city-gallery")).toHaveCount(0);
    await expect(page.locator(".cesium-widget canvas")).toHaveCount(0);
    expect(requests.some((url) => /scene\.json|\/cesium\//i.test(url))).toBe(
      false,
    );
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
  });

  test(`${city} opens its starting photograph in 3D directly from home`, async ({
    page,
  }) => {
    if (!productionPreview) test.slow();
    await page.goto("/");
    await page.locator(`.scene-card[href="/explore/${city}?view=3d"]`).click();
    await expect(page.locator(".cesium-widget canvas")).toBeVisible({
      timeout: viewerStartupTimeout,
    });
    await expect(page.locator("[data-open-3d]")).toBeEnabled();
    await expect(page.locator("[data-city-map-experience]")).toHaveAttribute(
      "data-city-map-mode",
      "3d",
    );
    await expect(page.locator(".city-selected-photo strong")).toHaveText(photo);
    await expect(page.locator(".city-gallery")).toHaveCount(0);
    const record = mapRecords.find((record) => record.id === photo)!;
    await expect(page.locator("[data-pose-status]")).toHaveAttribute(
      "data-pose-status",
      record.calibration,
    );
    const cameraTools = page.getByRole("complementary", {
      name: "Camera tools",
    });
    for (const [name, available] of [
      ["Show frustum", record.capabilities.frustum],
      ["Align camera", record.capabilities.comparison],
      ["Compare photo", record.capabilities.comparison],
    ] as const) {
      const control = cameraTools.getByRole("button", { name, exact: true });
      await expect(control).toBeVisible();
      if (available) await expect(control).toBeEnabled();
      else await expect(control).toBeDisabled();
    }
    await page
      .getByRole("button", { name: "2D satellite", exact: true })
      .click();
    await expect(page.locator(".cesium-widget canvas")).toHaveCount(0);
    await expect(page.locator("[data-city-map-experience]")).toHaveAttribute(
      "data-city-map-mode",
      "2d",
    );
  });
}

test("an explicit photograph link overrides the city default", async ({
  page,
}) => {
  await page.goto(`/explore/san-francisco?photo=${alignmentPhoto.id}`);
  await expect(page.locator(".city-selected-photo strong")).toHaveText(
    alignmentPhoto.id,
  );
});

test("invalid photograph links and browser history restore the city default", async ({
  page,
}) => {
  await page.goto("/explore/san-francisco?photo=not-a-published-photo");
  const selected = page.locator(".city-selected-photo strong");
  await expect(selected).toHaveText("img-7561");
  await expect(page.locator("[data-open-3d]")).toBeEnabled();
  await page.evaluate((photoId) => {
    history.replaceState({}, "", "/explore/san-francisco");
    history.pushState({}, "", `/explore/san-francisco?photo=${photoId}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, alignmentPhoto.id);
  await expect(selected).toHaveText(alignmentPhoto.id);
  await page.goBack();
  await expect(page).toHaveURL(/\/explore\/san-francisco$/);
  await expect(selected).toHaveText("img-7561");
});

test("camera controls render a frustum and retain comparison through resizing", async ({
  page,
}) => {
  if (!productionPreview) test.slow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/explore/san-francisco?photo=${alignmentPhoto.id}`);
  const cameraTools = page.getByRole("complementary", { name: "Camera tools" });
  const stage = page.locator(".city-atlas-stage");
  await expect(cameraTools).toBeVisible();
  const initialToolsBounds = await cameraTools.boundingBox();
  const initialStageBounds = await stage.boundingBox();
  expect(initialToolsBounds).not.toBeNull();
  expect(initialStageBounds).not.toBeNull();
  if ((page.viewportSize()?.width ?? 0) >= 1000) {
    expect(initialToolsBounds!.x).toBeGreaterThanOrEqual(
      initialStageBounds!.x + initialStageBounds!.width - 1,
    );
  }
  for (const name of ["Show frustum", "Align camera", "Compare photo"]) {
    const control = cameraTools.getByRole("button", { name, exact: true });
    await expect(control).toBeVisible();
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(
      bounds!.height,
      `${name} touch target height`,
    ).toBeGreaterThanOrEqual(48);
    expect(bounds!.width, `${name} touch target width`).toBeGreaterThanOrEqual(
      48,
    );
  }
  await cameraTools
    .getByRole("button", { name: "Show frustum", exact: true })
    .click();
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
  const mobileToolsBounds = await cameraTools.boundingBox();
  const mobileStageBounds = await stage.boundingBox();
  expect(mobileToolsBounds).not.toBeNull();
  expect(mobileStageBounds).not.toBeNull();
  expect(mobileToolsBounds!.y).toBeGreaterThanOrEqual(
    mobileStageBounds!.y + mobileStageBounds!.height - 1,
  );
  for (const name of ["Show frustum", "Align camera", "Hide comparison"]) {
    const control = cameraTools.getByRole("button", { name, exact: true });
    await expect(control).toBeVisible();
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(
      bounds!.height,
      `${name} mobile touch target height`,
    ).toBeGreaterThanOrEqual(48);
    expect(
      bounds!.width,
      `${name} mobile touch target width`,
    ).toBeGreaterThanOrEqual(48);
  }
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
  const cameraTools = page.getByRole("complementary", { name: "Camera tools" });
  for (const name of ["Show frustum", "Align camera", "Compare photo"]) {
    await expect(
      cameraTools.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  }
  await page.getByRole("button", { name: "2D satellite", exact: true }).click();
  releaseRoot?.();
  await expect(page.locator("[data-city-map-experience]")).toHaveAttribute(
    "data-city-map-mode",
    "2d",
  );
  await expect(page.locator(".cesium-widget canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "Show frustum", exact: true }).click();
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
    /could not start|3D unavailable/i,
  );
  await expect(page.locator(".cesium-widget canvas")).toHaveCount(0);
  failing = false;
  await page.getByRole("button", { name: "Show frustum", exact: true }).click();
  await expect(page.getByRole("button", { name: "Hide frustum" })).toBeVisible({
    timeout: viewerStartupTimeout,
  });
});

test("the photograph drawer closes by keyboard and restores focus", async ({
  page,
}) => {
  await page.goto("/explore/san-francisco");
  const opener = page.locator('[aria-controls="city-photo-drawer"]');
  await expect(opener).toBeEnabled();
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await opener.focus();
  await page.keyboard.press("Enter");
  const drawer = page.locator("#city-photo-drawer");
  await expect(opener).toHaveAttribute("aria-expanded", "true");
  const close = page.getByRole("button", { name: "Close photo index" });
  await close.focus();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveAttribute("data-open", "false");
  await expect(opener).toBeFocused();
  await expect(drawer).toHaveAttribute("inert");
});

test("all public sections fit a 320 pixel screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  for (const route of [
    "/",
    "/explore",
    "/explore/san-francisco",
    "/explore/toronto",
    "/methodology",
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

test("starting photographs and page navigation remain available without JavaScript", async ({
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
  await expect(page.locator(".city-selected-photo img")).toBeVisible();
  await expect(page.locator(".city-selected-photo strong")).toHaveText(
    "img-7561",
  );
  await expect(page.getByText(/Maps and 3D require JavaScript/)).toBeVisible();
  await expect(page.locator(".city-gallery")).toHaveCount(0);
  await page.goto(
    "http://127.0.0.1:" +
      (process.env.PLAYWRIGHT_PORT ?? "4333") +
      "/explore/toronto",
  );
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(page.locator(".city-selected-photo strong")).toHaveText(
    "img-7449",
  );
  const cameraTools = page.getByRole("complementary", { name: "Camera tools" });
  for (const name of ["Show frustum", "Align camera", "Compare photo"]) {
    const control = cameraTools.getByRole("button", { name, exact: true });
    await expect(control).toBeVisible();
    await expect(control).toBeDisabled();
  }
  await expectResponsiveViewport(page);
  await page
    .getByRole("link", { name: "Collection", exact: true })
    .first()
    .click();
  await expect(page.locator(".scene-card")).toHaveCount(2);
  await expect(
    page.getByRole("heading", { name: /A place\.\s*A point of view\./ }),
  ).toBeVisible();
  await context.close();
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
  const cameraTools = page.getByRole("complementary", { name: "Camera tools" });
  for (const name of ["Show frustum", "Align camera", "Compare photo"]) {
    await expect(
      cameraTools.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  }
  expect(requests.some((url) => /scene\.json|\/cesium\//i.test(url))).toBe(
    false,
  );
});

test("places outside San Francisco and Toronto have no public pages or scene data", async ({
  request,
}) => {
  const publicCities = new Set<string>(startingPhotos.map(([city]) => city));
  const removedCities = [
    ...new Set(mapRecords.map((photo) => photo.sceneId)),
  ].filter((city) => !publicCities.has(city));
  for (const city of removedCities) {
    const response = await request.get(`/explore/${city}`);
    expect(response.status(), city).toBe(404);
    const scene = await request.get(`/explore/${city}/scene.json`);
    expect(scene.status(), `${city} scene`).toBe(404);
  }
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
